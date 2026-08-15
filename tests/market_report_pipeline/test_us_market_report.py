from __future__ import annotations

from pathlib import Path

import pandas as pd

from market_report_pipeline.us_market_report import (
    SECTOR_DISPLAY_NAMES,
    _event_latest_value,
    archive_legacy_reports,
    build_macro_dashboard,
    classify_market_state,
)


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


