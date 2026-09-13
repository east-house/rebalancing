from datetime import datetime, timezone
import copy
import pytest
from market_report_pipeline import portfolio_evening as evening, report_time, daily_reports
from market_report_pipeline.report_store import ReportStore
from test_report_integrity import FakeS3


def test_nineteen_boundary_and_other_schedules_are_preserved():
    before = datetime(2026, 9, 14, 9, 59, tzinfo=timezone.utc)
    at = datetime(2026, 9, 14, 10, 0, tzinfo=timezone.utc)
    assert report_time.due_dates("portfolio", "2026-09-14", set(), before) == []
    assert report_time.due_dates("portfolio", "2026-09-14", set(), at) == ["2026-09-14"]
    assert report_time.scheduled_for("2026-09-14").isoformat() == "2026-09-13T22:30:00+00:00"
    assert report_time.scheduled_for("2026-09-14", "trading").isoformat() == "2026-09-14T10:13:00+00:00"
    assert report_time.due_dates("portfolio", "2026-09-18", set(), datetime(2026, 9, 20, 12, tzinfo=timezone.utc)) == ["2026-09-18"]


def test_archive_is_preserved_in_an_independent_release():
    client = FakeS3()
    morning = ReportStore(client, "b", "morning")
    old = {"report_date_kst": "2026-09-11", "signal_market_date": "2026-09-10"}
    morning.stage("portfolio-reports/2026-09-11.json", old)
    morning.stage("portfolio-reports/index.json", {"reports": [{"reportDate": "2026-09-11"}]})
    morning.commit()
    original = copy.deepcopy(morning.manifest)
    portfolio = ReportStore(client, "b", "portfolio")
    evening.initialize_archive(portfolio, morning)
    assert portfolio.load("portfolio-reports/latest.json") == old
    assert portfolio.manifest["jobs"] == {}
    assert morning.manifest == original
    assert portfolio.pointer != morning.pointer


def test_evening_publication_records_cutoff_execution_and_success(monkeypatch):
    now = datetime(2026, 9, 14, 10, 15, tzinfo=timezone.utc)
    monkeypatch.setattr(report_time, "utc_now", lambda: now)
    portfolio = ReportStore(FakeS3(), "b", "portfolio")
    payload = {"report_date_kst": "2026-09-14", "signal_market_date": "2026-09-11", "proposed_execution_date": "2026-09-14", "generated_at": now.isoformat()}
    evening.publish_portfolio(portfolio, "2026-09-14", payload)
    saved = portfolio.load("portfolio-reports/latest.json")
    assert saved["report_time_kst"] == "19:00"
    assert saved["context"]["dataCutoffAt"] == "2026-09-11T20:00:00+00:00"
    assert saved["context"]["executionCloseAt"] == "2026-09-14T20:00:00+00:00"
    assert portfolio.manifest["jobs"]["2026-09-14"]["status"] == "published"
    with pytest.raises(ValueError, match="immutable"):
        evening.publish_portfolio(portfolio, "2026-09-14", payload)


def test_early_or_future_data_is_not_published(monkeypatch):
    portfolio = ReportStore(FakeS3(), "b", "portfolio")
    payload = {"report_date_kst": "2026-09-14", "signal_market_date": "2026-09-14", "proposed_execution_date": "2026-09-14"}
    monkeypatch.setattr(report_time, "utc_now", lambda: datetime(2026, 9, 14, 9, 59, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="not due"):
        evening.publish_portfolio(portfolio, "2026-09-14", payload)
    monkeypatch.setattr(report_time, "utc_now", lambda: datetime(2026, 9, 14, 10, 1, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="cutoff"):
        evening.publish_portfolio(portfolio, "2026-09-14", payload)
    assert portfolio.manifest["objects"] == {}


def test_morning_no_longer_publishes_portfolio_after_effective_date(tmp_path, monkeypatch):
    from market_report_pipeline import publish_market_report_web as web
    monkeypatch.setattr(daily_reports, "utc_now", lambda: datetime(2026, 9, 14, 0, tzinfo=timezone.utc))
    bundle = {"displayDate": "2026-09-14", "marketDate": "2026-09-11", "generatedAt": "2026-09-14T00:00:00Z", "summary": {"state": {}, "topSector": {}, "topTheme": {}}}
    monkeypatch.setattr(web, "build_web_bundle", lambda _: copy.deepcopy(bundle))
    (tmp_path / "MARKET_REPORT.html").write_text("report")
    (tmp_path / "market_dashboard.png").write_bytes(b"png")
    store = ReportStore(FakeS3(), "b", "morning")
    daily_reports.publish_morning(store, "2026-09-14", tmp_path)
    assert store.load("market-reports/2026-09-14.json") is not None
    assert store.load("portfolio-reports/2026-09-14.json") is None
