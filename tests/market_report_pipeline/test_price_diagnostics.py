from datetime import datetime, timedelta, timezone
import gzip
import json

import pandas as pd
import pytest
import requests

from market_report_pipeline import support
from market_report_pipeline.price_diagnostics import raw_readiness, summarize_pair, timing_report, observe, upload_and_history


def response(close=100):
    value = requests.Response()
    value.status_code = 200
    value.headers = {"Date": "Fri, 11 Sep 2026 00:00:00 GMT", "Set-Cookie": "private"}
    value._content = json.dumps({"chart": {"result": [{
        "timestamp": [int(pd.Timestamp("2026-09-10T13:30:00Z").timestamp())],
        "indicators": {"quote": [{"open": [100], "high": [101], "low": [99], "close": [close], "volume": [1000]}]}
    }]}}).encode()
    return value


@pytest.mark.parametrize("close,ready", [(100, True), (None, False)])
def test_raw_response_and_parser_result_are_preserved(tmp_path, monkeypatch, close, ready):
    value = response(close)
    monkeypatch.setattr(support.requests, "get", lambda *a, **kw: value)
    try:
        support._download_yahoo_frame("AAPL", pd.Timestamp("2026-09-01"), pd.Timestamp("2026-09-11"),
                                      timeout=20, max_retries=1, expected_latest=pd.Timestamp("2026-09-10"), diagnostics_dir=tmp_path)
    except RuntimeError:
        assert not ready
    row = json.loads(next(tmp_path.glob("*.json")).read_text())
    raw = gzip.decompress((tmp_path / row["rawFile"]).read_bytes())
    assert raw == value.content
    assert row["parserReady"] is ready
    assert raw_readiness(raw, "2026-09-10")[0] is ready
    assert "Set-Cookie" not in row["headers"]
    assert row["expectedSession"] == "2026-09-10"


def test_network_failure_is_observed(tmp_path, monkeypatch):
    def fail(*a, **kw):
        raise requests.Timeout("timeout")
    monkeypatch.setattr(support.requests, "get", fail)
    with pytest.raises(RuntimeError):
        support._download_yahoo_frame("AAPL", pd.Timestamp("2026-09-01"), pd.Timestamp("2026-09-11"),
                                      timeout=20, max_retries=1, diagnostics_dir=tmp_path)
    row = json.loads(next(tmp_path.glob("*.json")).read_text())
    assert row["status"] is None and row["parserReady"] is False
    assert "Timeout" in row["error"] and "rawFile" not in row


def pair(ready1=True, ready2=True, skew=0):
    start = datetime(2026, 9, 11, tzinfo=timezone.utc)
    return [{"url": f"https://query{i + 1}.finance.yahoo.com/chart/AAPL", "startedAt": (start + timedelta(seconds=i * skew)).isoformat(),
             "status": 200, "parserReady": ready, "rawReady": ready} for i, ready in enumerate([ready1, ready2])]


def test_endpoint_difference_and_parser_failure_are_distinct():
    assert summarize_pair(pair(False, True))["classification"] == "endpoint_readiness_difference"
    assert summarize_pair(pair(False, False))["classification"] == "both_incomplete"
    assert summarize_pair(pair())["classification"] == "both_ready"
    assert summarize_pair(pair(False, True, 6))["classification"] == "comparison_time_skew"
    rows = pair()
    rows[0]["parserReady"] = False
    assert summarize_pair(rows)["classification"] == "raw_complete_parser_failed"
    assert summarize_pair([])["classification"] == "missing_observation"


def test_full_pair_probe_has_no_cache_and_keeps_identical_parameters(tmp_path, monkeypatch):
    calls = []
    def get(url, **kw):
        calls.append((url, kw["params"]))
        return response(None if "query1" in url else 100)
    monkeypatch.setattr(support.requests, "get", get)
    checks = observe(["AAPL", "IVV"], pd.Timestamp("2026-09-10"), tmp_path)
    assert len(calls) == 4
    assert all(params == calls[0][1] for _, params in calls)
    assert all(row["classification"] == "endpoint_readiness_difference" for row in checks.values())
    assert len(list(tmp_path.glob("*.body.gz"))) == 4


def observation(day, hour, ready):
    close = datetime(2026, 9, day, 20, tzinfo=timezone.utc)
    start = close + timedelta(hours=hour)
    return {"marketSessionDate": close.date().isoformat(), "dataCutoffAt": close.isoformat(),
            "startedAt": start.isoformat(), "finishedAt": (start + timedelta(minutes=1)).isoformat(),
            "allBothReady": ready, "minutesAfterCloseAtFinish": hour * 60 + 1}


def test_timing_needs_ten_sessions_and_tracks_bounds_and_regression():
    history = [observation(1, 4, False), observation(1, 8, True)]
    for row in history:
        row["symbolObservations"] = {"AAPL": {"bothReady": row["allBothReady"], "observedAt": row["finishedAt"]}}
    report = timing_report(history)
    assert report["provisionalMinutesAfterClose"] is None
    assert report["sessions"][0]["lastNotReadyObservedAt"] == history[0]["finishedAt"]
    assert report["sessions"][0]["firstAllReadyObservedAt"] == history[1]["finishedAt"]
    assert report["sessions"][0]["maxObservationGapMinutes"] == 240
    assert report["sessions"][0]["symbols"]["AAPL"]["firstReadyObservedAt"] == history[1]["finishedAt"]
    assert report["sessions"][0]["symbols"]["AAPL"]["lastNotReadyBeforeFirstReady"] == history[0]["finishedAt"]
    history += [observation(day, 8, True) for day in range(2, 11)]
    report = timing_report(history)
    assert report["provisionalMinutesAfterClose"] == 511
    assert report["provisionalKstTimeUsingLatestSessionClose"] == "13:31"
    history.append(observation(10, 9, False))
    assert timing_report(history)["provisionalMinutesAfterClose"] is None
    history.append(observation(11, 4, False))
    assert timing_report(history)["fullyReadySessions"] == 10


def test_diagnostic_disk_failure_does_not_break_prices(tmp_path, monkeypatch, caplog):
    target = tmp_path / "not-directory"
    target.write_text("occupied")
    monkeypatch.setattr(support.requests, "get", lambda *a, **kw: response())
    frame = support._download_yahoo_frame("AAPL", pd.Timestamp("2026-09-01"), pd.Timestamp("2026-09-11"),
                                          timeout=20, max_retries=1, diagnostics_dir=target)
    assert len(frame) == 1
    assert "PRICE_DIAGNOSTIC_WRITE_FAILED" in caplog.text


def test_r2_evidence_is_separate_immutable_and_history_is_compact(tmp_path):
    from io import BytesIO
    from zipfile import ZipFile
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "test.body.gz").write_bytes(gzip.compress(b"raw"))
    data = {}

    class Client:
        def put_object(self, **kwargs):
            assert kwargs["Key"].startswith("price-diagnostics/")
            assert kwargs["Key"] not in data
            data[kwargs["Key"]] = kwargs["Body"]

        def get_paginator(self, name):
            assert name == "list_objects_v2"
            return self

        def paginate(self, **kwargs):
            return [{"Contents": [{"Key": key} for key in data if key.startswith(kwargs["Prefix"])]}]

        def get_object(self, **kwargs):
            return {"Body": BytesIO(data[kwargs["Key"]])}

    snapshot = {**observation(10, 8, True), "observationId": "run-unique", "checks": {"AAPL": "evidence"}}
    history = upload_and_history(snapshot, tmp_path, Client(), "bucket")
    assert len(history) == 1 and "checks" not in history[0]
    assert history[0]["allBothReady"] is True
    archive = ZipFile(BytesIO(data["price-diagnostics/raw/run-unique.zip"]))
    assert json.loads(archive.read("summary.json"))["checks"] == snapshot["checks"]
    assert gzip.decompress(archive.read("test.body.gz")) == b"raw"


def test_bad_http_body_is_not_reported_as_endpoint_data_difference():
    rows = pair()
    rows[0].update(status=429, rawReady=None, parserReady=False)
    assert summarize_pair(rows)["classification"] == "transport_or_invalid_response"
    assert raw_readiness(response().content, "2026-09-09") == (False, [])


def test_expired_probe_budget_does_not_request_and_marks_missing(tmp_path, monkeypatch):
    from market_report_pipeline import price_diagnostics as diagnostics
    clock = iter([0, 901])
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: next(clock, 901))
    monkeypatch.setattr(support.requests, "get", lambda *a, **kw: pytest.fail("request after budget"))
    checks = observe(["AAPL", "IVV"], pd.Timestamp("2026-09-10"), tmp_path)
    assert all(row["classification"] == "missing_observation" for row in checks.values())
