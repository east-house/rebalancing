from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from market_report_pipeline.us_ircs_forward_report import (
    CONFIG,
    G55_STRATEGY,
    R2_STRATEGY,
    _merge_index,
    _new_account,
    _passes_entry_variant,
    account_snapshot,
    execute_pending,
    load_seed_state,
    transaction_cost_model,
    validate_publication_time,
)


def test_forward_seed_uses_first_complete_session_without_fabricated_prices() -> None:
    state = load_seed_state()

    assert CONFIG["strategy"]["version"] == "IRCS-G55-R2-FORWARD-2026-09-01"
    assert CONFIG["strategy"]["initial_signal_date"] == "2026-08-31"
    assert state["initializedSignalDate"] == "2026-08-31"
    assert state["lastProcessedMarketDate"] == "2026-08-31"
    assert all(
        state["accounts"][strategy]["cash"] == 21_000.0
        for strategy in (G55_STRATEGY, R2_STRATEGY)
    )


def test_execute_pending_uses_next_close_and_published_buy_cost() -> None:
    account = _new_account(21_000.0)
    decision = {
        "signalDate": "2026-08-26",
        "orders": [
            {
                "side": "BUY",
                "ticker": "AAA",
                "reason": "ircs_entry",
                "themeBucket": "Theme::Test",
            }
        ],
    }
    date = pd.Timestamp("2026-08-27")
    close = pd.DataFrame({"AAA": [100.0]}, index=[date])

    completed = execute_pending(account, decision, date, close)

    assert completed[0]["shares"] == 52.5
    assert completed[0]["notional"] == 5_250.0
    assert completed[0]["fee"] == 13.125
    assert account["cash"] == 15_736.875
    assert account["positions"]["AAA"]["entryPrice"] == 100.0


def test_transaction_cost_model_separates_buy_and_sell_rates() -> None:
    model = transaction_cost_model()

    assert model["buyRate"] == pytest.approx(0.0025)
    assert model["sellRate"] == pytest.approx(0.0025206)


def test_g55_and_r2_apply_distinct_frozen_entry_filters() -> None:
    assert _passes_entry_variant(G55_STRATEGY, cci_gap=55.0034894356, target_room=0.0)
    assert not _passes_entry_variant(G55_STRATEGY, cci_gap=55.0, target_room=0.10)
    assert _passes_entry_variant(R2_STRATEGY, cci_gap=-10.0, target_room=0.02)
    assert not _passes_entry_variant(R2_STRATEGY, cci_gap=100.0, target_room=0.0199)


def test_account_snapshot_keeps_two_accounts_independent() -> None:
    date = pd.Timestamp("2026-08-27")
    close = pd.DataFrame({"AAA": [110.0]}, index=[date])
    first = _new_account(21_000.0)
    second = _new_account(21_000.0)
    execute_pending(
        first,
        {"signalDate": "2026-08-26", "orders": [{
            "side": "BUY", "ticker": "AAA", "reason": "ircs_entry",
            "themeBucket": "Theme::Test",
        }]},
        date,
        close,
    )

    first_snapshot = account_snapshot(first, date, close)
    second_snapshot = account_snapshot(second, date, close)

    assert first_snapshot["positionCount"] == 1
    assert second_snapshot["positionCount"] == 0
    assert second_snapshot["equity"] == 21_000.0


def test_report_index_is_dated_and_idempotent() -> None:
    report = {
        "reportDate": "2026-08-27",
        "marketDate": "2026-08-26",
        "generatedAt": "2026-08-27T10:00:00Z",
        "accounts": {
            G55_STRATEGY: {"equity": 21_000.0},
            R2_STRATEGY: {"equity": 21_000.0},
        },
        "nextActions": {
            G55_STRATEGY: {"orders": []},
            R2_STRATEGY: {"orders": []},
        },
    }

    first = _merge_index(None, [report])
    second = _merge_index(first, [report])

    assert second["latestReportDate"] == "2026-08-27"
    assert len(second["reports"]) == 1


def test_new_g55_index_keeps_older_m_report_in_archive() -> None:
    legacy_item = {
        "reportDate": "2026-08-27",
        "marketDate": "2026-08-26",
        "generatedAt": "2026-08-27T10:00:00Z",
        "mEquity": 21_000.0,
        "r2Equity": 21_000.0,
        "mNextActionCount": 0,
        "r2NextActionCount": 0,
    }
    g55_report = {
        "reportDate": "2026-08-29",
        "marketDate": "2026-08-28",
        "generatedAt": "2026-08-30T10:00:00Z",
        "accounts": {
            G55_STRATEGY: {"equity": 21_000.0},
            R2_STRATEGY: {"equity": 21_000.0},
        },
        "nextActions": {
            G55_STRATEGY: {"orders": []},
            R2_STRATEGY: {"orders": []},
        },
    }

    result = _merge_index({"schemaVersion": 1, "reports": [legacy_item]}, [g55_report])

    assert result["schemaVersion"] == 2
    assert [item["reportDate"] for item in result["reports"]] == [
        "2026-08-29",
        "2026-08-27",
    ]
    assert result["reports"][1]["mEquity"] == 21_000.0


def test_same_day_report_is_blocked_before_1900_kst() -> None:
    now = datetime(2026, 8, 28, 9, 59, tzinfo=timezone.utc)  # 18:59 KST

    with pytest.raises(RuntimeError, match="19:00 Asia/Seoul"):
        validate_publication_time(pd.Timestamp("2026-08-28"), now)


def test_same_day_report_is_allowed_at_1900_kst() -> None:
    now = datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)  # 19:00 KST

    validate_publication_time(pd.Timestamp("2026-08-28"), now)
