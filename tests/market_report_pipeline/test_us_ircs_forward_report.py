from __future__ import annotations

import pandas as pd

from market_report_pipeline.us_ircs_forward_report import (
    _merge_index,
    _new_account,
    account_snapshot,
    execute_pending,
)


def test_execute_pending_uses_next_close_and_one_way_cost() -> None:
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
    assert completed[0]["fee"] == 5.25
    assert account["cash"] == 15_744.75
    assert account["positions"]["AAA"]["entryPrice"] == 100.0


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
            "IRCS-BBCCI-M": {"equity": 21_000.0},
            "IRCS-BBCCI-M-R2": {"equity": 21_000.0},
        },
        "nextActions": {
            "IRCS-BBCCI-M": {"orders": []},
            "IRCS-BBCCI-M-R2": {"orders": []},
        },
    }

    first = _merge_index(None, [report])
    second = _merge_index(first, [report])

    assert second["latestReportDate"] == "2026-08-27"
    assert len(second["reports"]) == 1
