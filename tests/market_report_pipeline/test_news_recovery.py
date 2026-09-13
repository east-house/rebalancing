import hashlib
from dataclasses import replace
import json
from pathlib import Path

import pandas as pd
import pytest

from market_report_pipeline import us_market_report as market


def article(day, title="Federal Reserve interest rate outlook"):
    return {"published_at": day, "title": title, "url": "https://example.test/press",
            "source": "Federal Reserve", "feed": "Federal Reserve"}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    cache, archive = tmp_path / "cache", tmp_path / "archive"
    cache.mkdir(); archive.mkdir()
    monkeypatch.setattr(market, "NEWS_CACHE_ROOT", cache)
    monkeypatch.setattr(market, "NEWS_ARCHIVE_ROOT", archive)
    class Response:
        content = b"<rss><channel/></rss>"
        def raise_for_status(self): pass
    monkeypatch.setattr(market.requests, "get", lambda *a, **k: Response())
    settings = market.MarketRunSettings(pd.Timestamp("2026-09-03"), pd.Timestamp("2025-01-01"), tmp_path, tmp_path)
    config = {"news": {"google_rss_queries": [], "lookback_days": 3, "max_items": 12},
              "macro": {"fed_press_feed_url": "https://example.test/rss"}}
    return settings, config, cache, archive


def test_empty_cached_result_retries_preserved_news_with_unchanged_window(setup):
    settings, config, cache, archive = setup
    (cache / "news_20260903_v2.json").write_text("[]", encoding="utf-8")
    path = archive / "preserved.json"
    path.write_text(json.dumps([article("2026-09-01T12:00:00"),
                                article("2026-08-29T23:59:59", "too old"),
                                article("2026-09-04T00:00:01", "too new")]), encoding="utf-8")
    original = path.read_bytes()
    frame, audit = market.collect_market_news(settings, pd.Timestamp("2026-09-02"), config)
    assert frame.title.tolist() == ["Federal Reserve interest rate outlook"]
    assert audit["archives"][0]["sha256"] == hashlib.sha256(original).hexdigest()
    assert path.read_bytes() == original


def test_existing_nonempty_cache_is_preserved(setup):
    settings, config, cache, archive = setup
    saved = [article("2026-09-01T12:00:00", "original cached article")]
    (cache / "news_20260903_v2.json").write_text(json.dumps(saved), encoding="utf-8")
    (archive / "preserved.json").write_text(json.dumps([article("2026-09-02T12:00:00")]), encoding="utf-8")
    frame, audit = market.collect_market_news(settings, pd.Timestamp("2026-09-02"), config)
    assert frame.title.tolist() == ["original cached article"]
    assert audit["cache_hit"]


def test_archive_cannot_turn_out_of_window_news_into_success(setup):
    settings, config, cache, archive = setup
    (archive / "preserved.json").write_text(json.dumps([article("2026-09-10T12:00:00")]), encoding="utf-8")
    frame, audit = market.collect_market_news(settings, pd.Timestamp("2026-09-02"), config)
    assert frame.empty and audit["rows"] == 0
    assert not (cache / "news_20260903_v2.json").exists()


@pytest.mark.parametrize("report_day,market_day", [("2026-08-18", "2026-08-17"), ("2026-09-03", "2026-09-02")])
def test_checked_in_preserved_articles_cover_both_actual_recovery_dates(setup, monkeypatch, report_day, market_day):
    settings, config, cache, _ = setup
    monkeypatch.setattr(market, "NEWS_ARCHIVE_ROOT", Path(__file__).resolve().parents[2] / "config/news-archive")
    settings = replace(settings, as_of=pd.Timestamp(report_day))
    frame, audit = market.collect_market_news(settings, pd.Timestamp(market_day), config)
    assert len(frame) > 0
    assert audit["archives"]
    assert frame.published_at.between(pd.Timestamp(market_day) - pd.Timedelta(days=3), settings.as_of + pd.Timedelta(days=1)).all()
