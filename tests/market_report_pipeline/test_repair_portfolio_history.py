from datetime import datetime, timezone

import pandas as pd
import pytest

from market_report_pipeline import repair_portfolio_history as repair
from market_report_pipeline.report_store import ReportStore
from test_report_integrity import FakeS3
from test_us_daily_portfolio_report import _market_data
from market_report_pipeline.us_daily_portfolio_report import build_device_payload


def test_full_archive_includes_all_twenty_weekdays_and_holidays():
    days = repair.report_days("2026-08-17", now=datetime(2026, 9, 13, tzinfo=timezone.utc))
    assert len(days) == 20
    assert days[0] == "2026-08-17" and days[-1] == "2026-09-11"
    assert repair.report_context(days[0])["marketSessionDate"] == "2026-08-14"
    for day in ("2026-09-07", "2026-09-08"):
        assert repair.report_context(day)["marketSessionDate"] == "2026-09-04"
        assert str(repair.next_execution_date(day).date()) == "2026-09-08"


def test_snapshot_excludes_report_day_and_future_membership(tmp_path):
    for day in ("20260816", "20260817", "20260901"):
        (tmp_path / f"sp500_{day}.parquet").touch()
    assert repair.snapshot_for("2026-08-17", tmp_path).name == "sp500_20260816.parquet"
    assert repair.snapshot_for("2026-08-18", tmp_path).name == "sp500_20260817.parquet"
    with pytest.raises(ValueError, match="preserved universe"):
        repair.snapshot_for("2026-08-16", tmp_path)


def _payload():
    data = _market_data()
    return build_device_payload(data, data.calendar[-1])


def test_publication_preserves_other_reports_and_original_portfolio():
    report = _payload()
    day = report["report_date_kst"]
    store = ReportStore(FakeS3(), "test", "morning")
    old = {**report, "strategy": {"id": "old"}}
    store.stage(f"portfolio-reports/{day}.json", old)
    store.stage(f"market-reports/{day}.json", {"untouched": True})
    first = store.commit(job_date=day)
    result = repair.publish([report], store=store)
    assert store.load(f"portfolio-reports/archive/{first['releaseId']}/{day}.json") == old
    assert store.load(f"portfolio-reports/{day}.json") == report
    assert store.load("portfolio-reports/latest.json") == report
    assert result["jobs"] == first["jobs"]
    assert result["objects"][f"market-reports/{day}.json"] == first["objects"][f"market-reports/{day}.json"]


def test_invalid_payload_fails_before_any_publication():
    report = _payload()
    store = ReportStore(FakeS3(), "test", "morning")
    report["signal_market_date"] = report["report_date_kst"]
    with pytest.raises(ValueError, match="Incorrect US session"):
        repair.publish([report], store=store)
    assert not store.client.objects
    assert not store.staged


def test_date_gap_is_rejected():
    report = _payload()
    with pytest.raises(ValueError, match="missing"):
        repair.validate([report], ["2026-08-17", "2026-08-18"])


def test_price_repair_fills_middle_gap_and_preserves_existing_bars(tmp_path, monkeypatch):
    from market_report_pipeline import support
    monkeypatch.setattr(repair, "STOCK_CACHE", tmp_path)
    old = pd.DataFrame({"date": pd.to_datetime(["2026-08-14", "2026-08-18"]), "close": [100.0, 102.0]})
    old.to_parquet(tmp_path / "IVV.parquet")
    def download(*args, **kwargs):
        return pd.DataFrame({"date": pd.to_datetime(["2026-08-17", "2026-08-18", "2026-08-19"]),
                             "close": [101.0, 999.0, 999.0]})
    monkeypatch.setattr(support, "_download_yahoo_frame", download)
    audit = repair.fill_price_gaps({"IVV"}, ["2026-08-17", "2026-08-18", "2026-08-19"], tmp_path)
    after = pd.read_parquet(tmp_path / "IVV.parquet")
    assert after["close"].tolist() == [100.0, 101.0, 102.0]
    assert audit[0]["missingBefore"] == ["2026-08-17"]
    assert audit[0]["missingAfter"] == []


def test_former_constituent_needs_prices_only_on_its_eligible_report_dates(tmp_path, monkeypatch):
    from market_report_pipeline import support
    monkeypatch.setattr(repair, "STOCK_CACHE", tmp_path)
    pd.DataFrame({"date": pd.to_datetime(["2026-08-14"]), "close": [100.0]}).to_parquet(tmp_path / "OLD.parquet")
    def unexpected(*args, **kwargs):
        pytest.fail("A former constituent must not require a later price")
    monkeypatch.setattr(support, "_download_yahoo_frame", unexpected)
    audit = repair.fill_price_gaps({"OLD"}, ["2026-08-17", "2026-09-11"], tmp_path,
                                  membership_days={"OLD": ["2026-08-17"]})
    assert audit[0]["missingAfter"] == []
