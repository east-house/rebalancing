from __future__ import annotations

from pathlib import Path

import pandas as pd
import market_report_pipeline.us_market_report as market_report

from market_report_pipeline.us_market_report import (
    MarketRunSettings,
    SECTOR_DISPLAY_NAMES,
    _align_index_closes,
    _completed_price_rows,
    _event_latest_value,
    _expected_market_date,
    audit_ma50_breadth,
    archive_legacy_reports,
    build_macro_dashboard,
    classify_market_state,
    collect_context_prices,
)


def test_expected_market_date_uses_latest_completed_us_calendar_day() -> None:
    assert _expected_market_date(pd.Timestamp("2026-09-01")) == pd.Timestamp("2026-08-31")
    assert _expected_market_date(pd.Timestamp("2026-09-05")) == pd.Timestamp("2026-09-04")
    assert _expected_market_date(pd.Timestamp("2026-09-07")) == pd.Timestamp("2026-09-04")


def test_completed_price_rows_removes_incomplete_yahoo_placeholder() -> None:
    frame = pd.DataFrame(
        [
            {
                "date": "2026-08-27",
                "open": 100.0,
                "high": 101.0,
                "low": 99.0,
                "close": 100.5,
                "volume": 1000,
            },
            {
                "date": "2026-08-28",
                "open": None,
                "high": None,
                "low": None,
                "close": None,
                "volume": 500,
            },
        ]
    )

    result = _completed_price_rows(frame)

    assert result["date"].tolist() == [pd.Timestamp("2026-08-27")]
    assert result["close"].tolist() == [100.5]


def test_context_price_collection_repairs_placeholder_cache(
    tmp_path: Path,
    monkeypatch,
) -> None:
    cache = tmp_path / "stocks"
    cache.mkdir()
    columns = [
        "date",
        "ticker",
        "provider_symbol",
        "open",
        "high",
        "low",
        "close",
        "volume",
    ]
    pd.DataFrame(
        [
            ["2026-08-27", "IVV", "IVV", 100.0, 101.0, 99.0, 100.5, 1000],
            ["2026-08-28", "IVV", "IVV", None, None, None, None, 500],
        ],
        columns=columns,
    ).to_parquet(cache / "IVV.parquet", index=False)
    request: dict[str, pd.Timestamp] = {}

    def fake_download(symbol, start, end_exclusive, *, timeout, max_retries):
        request["start"] = pd.Timestamp(start)
        request["end"] = pd.Timestamp(end_exclusive)
        return pd.DataFrame(
            [
                ["2026-08-28", symbol, symbol, 101.0, 102.0, 100.0, 101.5, 1100],
                ["2026-08-31", symbol, symbol, 102.0, 103.0, 101.0, 102.5, 1200],
            ],
            columns=columns,
        )

    monkeypatch.setattr(market_report, "STOCK_CACHE", cache)
    monkeypatch.setattr(market_report, "_download_yahoo_frame", fake_download)
    settings = MarketRunSettings(
        as_of=pd.Timestamp("2026-09-01"),
        history_start=pd.Timestamp("2026-08-01"),
        output_dir=tmp_path / "output",
        config_path=tmp_path / "config.yaml",
    )
    config = {
        "data": {
            "cache_overlap_days": 5,
            "request_timeout_seconds": 10,
            "max_retries": 1,
            "request_workers": 1,
        }
    }

    result, audit = collect_context_prices(["IVV"], settings, config)
    repaired = pd.read_parquet(cache / "IVV.parquet")

    assert request == {
        "start": pd.Timestamp("2026-08-22"),
        "end": pd.Timestamp("2026-09-01"),
    }
    assert result["date"].max() == pd.Timestamp("2026-08-31")
    assert repaired["date"].max() == pd.Timestamp("2026-08-31")
    assert repaired[["open", "high", "low", "close"]].notna().all().all()
    assert audit["end"] == pd.Timestamp("2026-08-31")


def test_index_chart_uses_one_timeline_and_preserves_missing_dates() -> None:
    dates = pd.date_range("2026-08-10", periods=4, freq="D")
    prices = pd.DataFrame(
        [
            *({"date": date, "ticker": "^GSPC", "close": 100 + position} for position, date in enumerate(dates)),
            {"date": dates[0], "ticker": "^NDX", "close": 200},
            {"date": dates[1], "ticker": "^NDX", "close": 202},
            {"date": dates[3], "ticker": "^NDX", "close": 206},
        ]
    )

    aligned = _align_index_closes(prices, ["^GSPC", "^NDX"], "^GSPC", periods=4)

    assert aligned.index.tolist() == dates.tolist()
    assert pd.isna(aligned.loc[dates[2], "^NDX"])
    assert aligned.loc[dates[3], "^NDX"] == 206


def test_ma50_breadth_audit_recomputes_raw_closes_and_reports_window() -> None:
    dates = pd.bdate_range("2026-08-10", periods=3)
    prices = pd.DataFrame(
        [
            *({"date": date, "ticker": "^GSPC", "close": 100 + position} for position, date in enumerate(dates)),
            *({"date": date, "ticker": "AAA", "close": value} for date, value in zip(dates, [10, 11, 13])),
            *({"date": date, "ticker": "BBB", "close": value} for date, value in zip(dates, [13, 12, 10])),
        ]
    )
    universe = pd.DataFrame(
        [
            {"ticker": "AAA", "sector": "Technology"},
            {"ticker": "BBB", "sector": "Utilities"},
        ]
    )
    sectors = pd.DataFrame(
        [
            {"sector": "Technology", "above_ma50_breadth": 1.0},
            {"sector": "Utilities", "above_ma50_breadth": 0.0},
        ]
    )

    result = audit_ma50_breadth(
        prices,
        universe,
        dates[-1],
        sectors,
        "^GSPC",
        periods=3,
    )

    assert result["window_start"] == dates[0]
    assert result["window_end"] == dates[-1]
    assert result["eligible_count"] == 2
    assert result["sector_max_abs_difference"] == 0
    assert result["passed"] is True


def test_market_state_detects_broad_advance() -> None:
    indices = pd.DataFrame(
        [
            {
                "name": "S&P 500",
                "date": pd.Timestamp("2026-08-14"),
                "return_1d": 0.002,
                "return_20d": 0.04,
                "ma200_gap": 0.10,
                "above_ma200": True,
            },
            {
                "name": "S&P 500 Equal Weight",
                "date": pd.Timestamp("2026-08-14"),
                "return_1d": 0.003,
                "return_20d": 0.035,
                "ma200_gap": 0.07,
                "above_ma200": True,
            },
        ]
    )
    stocks = pd.DataFrame(
        {
            "above_ma20": [True] * 7 + [False] * 3,
            "above_ma50": [True] * 6 + [False] * 4,
            "above_ma200": [True] * 7 + [False] * 3,
            "return_1d": [0.01] * 6 + [-0.01] * 4,
        }
    )
    risks = pd.DataFrame([{"name": "VIX", "close": 14.0}])

    result = classify_market_state(indices, stocks, risks)

    assert result["state"] == "상승 확산"
    assert result["risk_level"] == "낮음"
    assert result["breadth_above_ma50"] == 0.6


def test_macro_dashboard_names_ppiaco_without_implying_final_demand() -> None:
    dates = pd.date_range("2025-06-01", periods=15, freq="MS")
    frame = pd.DataFrame({"date": dates, "PPIACO": range(100, 115)})

    result = build_macro_dashboard(frame, pd.Timestamp("2026-08-14"))
    row = result.loc[result["series"].eq("PPIACO")].iloc[0]

    assert row["indicator"] == "광범위 상품 생산자물가 전년비"
    assert "최종수요 PPI와 다른 계열" in row["interpretation"]
    assert _event_latest_value("Producer Price Index", result).endswith("(관측 2026-08-01)")


def test_sector_display_names_are_bilingual() -> None:
    assert SECTOR_DISPLAY_NAMES["Health Care"] == "건강관리 (Health Care)"
    assert len(SECTOR_DISPLAY_NAMES) == 11


def test_legacy_reports_move_to_old_locations(tmp_path: Path) -> None:
    latest = tmp_path / "LATEST_REPORT.md"
    latest.write_text("legacy", encoding="utf-8")
    dated = tmp_path / "2026-08-15"
    dated.mkdir()
    legacy_file = dated / "DAILY_REPORT.md"
    legacy_file.write_text("legacy daily", encoding="utf-8")

    result = archive_legacy_reports(tmp_path)

    assert result["moved_count"] == 2
    assert not latest.exists()
    assert (tmp_path / "LATEST_REPORT_old.md").read_text(encoding="utf-8") == "legacy"
    assert (dated / "_old" / "DAILY_REPORT.md").read_text(encoding="utf-8") == "legacy daily"
