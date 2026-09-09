from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pandas as pd
import pytest

from market_report_pipeline.report_store import ReportStore, ReleaseConflict, encode
from market_report_pipeline.report_time import due_dates, expected_market_date, next_execution_date, report_context
from market_report_pipeline.daily_reports import recover_market_index


class StorageError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.fail = None

    def get_object(self, *, Key, **_):
        if Key not in self.objects:
            raise StorageError("NoSuchKey")
        body = self.objects[Key]
        return {"Body": BytesIO(body), "ETag": hashlib.sha256(body).hexdigest()}

    def put_object(self, *, Key, Body, IfMatch=None, IfNoneMatch=None, **_):
        if self.fail and self.fail in Key:
            raise StorageError("ServiceUnavailable")
        current = hashlib.sha256(self.objects[Key]).hexdigest() if Key in self.objects else None
        if IfMatch is not None and current != IfMatch or IfNoneMatch == "*" and current is not None:
            raise StorageError("PreconditionFailed")
        self.objects[Key] = Body
        return {"ETag": hashlib.sha256(Body).hexdigest()}

    def get_paginator(self, _):
        return self

    def paginate(self, *, Prefix, **_):
        yield {"Contents": [{"Key": key} for key in self.objects if key.startswith(Prefix)]}


@pytest.mark.parametrize("day,session,execution", [
    ("2026-09-07", "2026-09-04", "2026-09-08"),
    ("2026-09-08", "2026-09-04", "2026-09-08"),
    ("2026-03-09", "2026-03-06", "2026-03-09"),
    ("2026-11-02", "2026-10-30", "2026-11-02"),
    ("2026-11-28", "2026-11-27", "2026-11-30"),
    ("2024-02-29", "2024-02-28", "2024-02-29"),
])
def test_calendar_boundaries(day, session, execution):
    assert str(expected_market_date(day).date()) == session
    assert str(next_execution_date(day).date()) == execution
    assert report_context(day)["marketSessionDate"] == session


def test_planner_recovers_every_missed_slot_after_48_hours():
    now = datetime(2026, 9, 10, 15, 15, tzinfo=timezone.utc)
    assert due_dates("trading", "2026-09-08", {"2026-09-09"}, now) == ["2026-09-08", "2026-09-10"]
    assert due_dates("morning", "2026-09-09", set(), now) == ["2026-09-09", "2026-09-10"]


def test_planner_uses_publication_instant_not_host_date():
    before = datetime(2026, 9, 8, 22, 29, tzinfo=timezone.utc)
    after = datetime(2026, 9, 8, 22, 30, tzinfo=timezone.utc)
    assert due_dates("morning", "2026-09-09", set(), before) == []
    assert due_dates("morning", "2026-09-09", set(), after) == ["2026-09-09"]


def test_cache_hit_never_returns_future_prices_or_truncates_the_download_cache(tmp_path, monkeypatch):
    from market_report_pipeline import us_market_report as market

    cache = tmp_path / "cache"
    cache.mkdir()
    frame = pd.DataFrame({"date": pd.to_datetime(["2026-09-04", "2026-09-08"]), "ticker": ["IVV", "IVV"],
                          "open": [100, 200], "high": [101, 201], "low": [99, 199], "close": [100, 200], "volume": [1000, 1000]})
    frame.to_parquet(cache / "IVV.parquet")
    monkeypatch.setattr(market, "STOCK_CACHE", cache)
    monkeypatch.setattr(market, "_download_yahoo_frame", lambda *_args, **_kwargs: pytest.fail("Cache should be used"))
    settings = market.MarketRunSettings(pd.Timestamp("2026-09-07"), pd.Timestamp("2026-01-01"), tmp_path / "out", tmp_path / "config")
    result, audit = market.collect_context_prices(["IVV"], settings, {"data": {"request_workers": 1, "minimum_fresh_symbols": 1}, "indices": {"S&P 500": "IVV"}})
    assert result["date"].max() == pd.Timestamp("2026-09-04")
    assert audit["end"] == pd.Timestamp("2026-09-04")
    assert len(pd.read_parquet(cache / "IVV.parquet")) == 2


def test_morning_publication_validates_both_reports_and_keeps_latest_monotonic(tmp_path, monkeypatch):
    from market_report_pipeline import daily_reports as daily
    from market_report_pipeline import publish_market_report_web as web

    client = FakeS3()
    store = ReportStore(client, "b", "morning")
    client.objects["portfolio-reports/latest.json"] = encode({"report_date_kst": "2026-09-09"})
    bundle = {"displayDate": "2026-09-08", "marketDate": "2026-09-04", "generatedAt": "2026-09-09T00:00:00Z",
              "summary": {"state": {}, "topSector": {}, "topTheme": {}}}
    monkeypatch.setattr(web, "build_web_bundle", lambda _: copy.deepcopy(bundle))
    (tmp_path / "MARKET_REPORT.html").write_text("<html></html>")
    (tmp_path / "market_dashboard.png").write_bytes(b"png")
    portfolio = {"report_date_kst": "2026-09-08", "signal_market_date": "2026-09-08", "generated_at": "now"}
    (tmp_path / "portfolio.json").write_bytes(encode(portfolio))
    with pytest.raises(ValueError, match="disagree"):
        daily.publish_morning(store, "2026-09-08", tmp_path)
    assert store.pointer not in client.objects
    portfolio["signal_market_date"] = "2026-09-04"
    (tmp_path / "portfolio.json").write_bytes(encode(portfolio))
    daily.publish_morning(store, "2026-09-08", tmp_path)
    fresh = ReportStore(client, "b", "morning")
    assert fresh.load("portfolio-reports/latest.json")["report_date_kst"] == "2026-09-09"
    assert fresh.load("portfolio-reports/2026-09-08.json")["reconstructed"] is True
    assert fresh.load("market-reports/2026-09-08.json")["marketDate"] == "2026-09-04"


def test_concurrent_commit_cannot_replace_a_newer_release():
    client = FakeS3()
    first, second = ReportStore(client, "b", "morning"), ReportStore(client, "b", "morning")
    first.stage("market-reports/index.json", {"date": "2026-09-09"})
    first.commit()
    second.stage("market-reports/index.json", {"date": "2026-09-08"})
    with pytest.raises(ReleaseConflict):
        second.commit()
    assert ReportStore(client, "b", "morning").load("market-reports/index.json")["date"] == "2026-09-09"


@pytest.mark.parametrize("failure", ["/objects/", "/releases/", "/current.json"])
def test_failed_upload_keeps_all_previous_public_objects(failure):
    client = FakeS3()
    store = ReportStore(client, "b", "trading")
    for key in ("index", "report", "state"):
        store.stage(key, {"version": 1})
    store.commit()
    previous = copy.deepcopy(store.manifest)
    client.fail = failure
    for key in ("index", "report", "state"):
        store.stage(key, {"version": 2})
    with pytest.raises(StorageError):
        store.commit()
    reader = ReportStore(client, "b", "trading")
    assert reader.manifest == previous
    assert all(reader.load(key)["version"] == 1 for key in ("index", "report", "state"))
    client.fail = None
    store.commit()
    assert all(ReportStore(client, "b", "trading").load(key)["version"] == 2 for key in ("index", "report", "state"))


def test_recover_missing_legacy_index_does_not_promote_staging_files():
    client = FakeS3()
    client.objects["market-reports/2026-09-04.json"] = encode({"displayDate": "2026-09-04", "marketDate": "2026-09-03", "generatedAt": "2026-09-04T01:00:00Z"})
    client.objects["report-publications/morning/objects/uncommitted"] = encode({"displayDate": "2099-01-01"})
    store = ReportStore(client, "b", "morning")
    index = recover_market_index(store)
    assert [item["displayDate"] for item in index["reports"]] == ["2026-09-04"]


def test_ircs_holiday_rerun_preserves_completed_trades_and_original_timestamp(tmp_path, monkeypatch):
    from market_report_pipeline import us_ircs_forward_report as ircs

    client = FakeS3()
    dates = pd.DatetimeIndex(["2026-09-03", "2026-09-04"])
    frame = pd.DataFrame({"IVV": [100.0, 101.0]}, index=dates)
    panel = ircs.MarketPanel(dates, frame, frame, frame, frame, frame, pd.DataFrame({"ticker": ["IVV"]}), Path("snapshot.parquet"))
    pending = {strategy: {"marketGate": {}, "orders": []} for strategy in ircs.STRATEGIES}
    state = {"strategyVersion": ircs.CONFIG["strategy"]["version"], "lastProcessedMarketDate": "2026-09-03",
             "accounts": {strategy: {"equity": 100, "count": 0} for strategy in ircs.STRATEGIES}, "pendingDecisions": pending}
    client.objects["trading-test-reports/state/latest.json"] = encode(state)
    monkeypatch.setattr(ircs.R2JsonStore, "from_environment", lambda prefix: ircs.R2JsonStore(client, "b", prefix))
    monkeypatch.setattr(ircs, "load_market_panel", lambda _: (panel, {"marketDate": "2026-09-04"}))
    monkeypatch.setattr(ircs, "_indicators", lambda _: {})
    monkeypatch.setattr(ircs, "_signals", lambda *_: {})
    monkeypatch.setattr(ircs, "make_decision", lambda *args: {"marketGate": {}, "orders": []})

    def execute(account, *args):
        account["count"] += 1
        return [{"side": "SELL", "ticker": "TFC", "fee": 1}]

    monkeypatch.setattr(ircs, "execute_pending", execute)
    monkeypatch.setattr(ircs, "build_report", lambda day, state, completed, decisions, *_: {
        "reportDate": str((day + pd.offsets.Day(1)).date()), "marketDate": str(day.date()), "generatedAt": "original",
        "accounts": copy.deepcopy(state["accounts"]), "completedActions": completed, "nextActions": decisions,
    })
    first = ircs.run(pd.Timestamp("2026-09-05"), tmp_path, upload_r2=True)
    second = ircs.run(pd.Timestamp("2026-09-08"), tmp_path, upload_r2=True)
    assert second["unchanged"] is True
    assert second["reports"] == first["reports"]
    assert second["state"] == first["state"]
    assert all(account["count"] == 1 for account in second["state"]["accounts"].values())
    current = ReportStore(client, "b", "trading")
    assert current.manifest["jobs"]["2026-09-08"]["status"] == "no-new-session"
    state["lastProcessedMarketDate"] = "2026-09-08"
    current.stage("trading-test-reports/state/latest.json", state)
    current.commit()
    with pytest.raises(ValueError, match="backwards"):
        ircs.run(pd.Timestamp("2026-09-05"), tmp_path, upload_r2=True, reset_ledger=True)


def test_runner_recovers_legacy_holes_even_when_job_history_starts_later(monkeypatch):
    import sys
    from market_report_pipeline import daily_reports as daily

    client = FakeS3()
    store = ReportStore(client, "b", "morning")
    store.stage("market-reports/index.json", {"reports": [{"displayDate": "2026-09-04"}]})
    store.commit(job_date="2026-09-08")
    monkeypatch.setattr(ReportStore, "from_environment", lambda _: ReportStore(client, "b", "morning"))
    monkeypatch.setattr(daily, "utc_now", lambda: datetime(2026, 9, 9, 0, tzinfo=timezone.utc))
    seen = []
    monkeypatch.setattr(daily, "generate_morning", lambda day, _: seen.append(day))
    monkeypatch.setattr(daily, "publish_morning", lambda *args, **kwargs: None)
    monkeypatch.setattr(sys, "argv", ["reports", "morning"])
    daily.main()
    assert seen == ["2026-09-07", "2026-09-09"]


def test_runner_records_generation_error_even_if_failure_status_upload_fails(tmp_path, monkeypatch):
    import sys
    from market_report_pipeline import daily_reports as daily

    client = FakeS3()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(ReportStore, "from_environment", lambda _: ReportStore(client, "b", "morning"))
    monkeypatch.setattr(daily, "utc_now", lambda: datetime(2026, 9, 9, 0, tzinfo=timezone.utc))

    def fail(*_):
        client.fail = "/current.json"
        raise ValueError("original data failure")

    monkeypatch.setattr(daily, "generate_morning", fail)
    monkeypatch.setattr(sys, "argv", ["reports", "morning", "--as-of", "2026-09-09"])
    with pytest.raises(RuntimeError, match="original data failure"):
        daily.main()
    failure = json.loads((tmp_path / "action-output/daily-reports/failures.json").read_text())[0]
    assert failure["error"] == "original data failure"
    assert "statusWriteError" in failure
