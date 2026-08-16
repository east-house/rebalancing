from __future__ import annotations

import copy

import numpy as np
import pandas as pd

from market_report_pipeline import us_daily_portfolio_report as report


def _market_data() -> report.MarketData:
    dates = pd.bdate_range("2024-01-02", periods=420)
    tickers = list("ABCDEFGH")
    rng = np.random.default_rng(7)
    close = pd.DataFrame(index=dates, columns=tickers, dtype=float)
    for number, ticker in enumerate(tickers):
        shocks = rng.normal(
            0.0003 + number * 0.00008,
            0.008 + number * 0.0002,
            len(dates),
        )
        close[ticker] = (40 + number * 3) * np.cumprod(1 + shocks)
    volume = pd.DataFrame(5_000_000.0, index=dates, columns=tickers)
    benchmark = pd.Series(
        100 * np.cumprod(1 + rng.normal(0.0003, 0.006, len(dates))), index=dates
    )
    universe = pd.DataFrame(
        {
            "ticker": tickers,
            "name": [f"Company {ticker}" for ticker in tickers],
            "sector": ["Tech", "Health", "Energy", "Finance"] * 2,
            "snapshot_date": dates.max(),
        }
    )
    return report.MarketData(
        calendar=dates,
        close=close,
        dollar_volume=close * volume,
        universe=universe,
        benchmark=benchmark,
        snapshot_path=report.Path("synthetic.parquet"),
    )


def test_monday_report_uses_previous_friday_and_monday_execution() -> None:
    calendar = pd.bdate_range("2026-08-03", "2026-08-14").append(
        pd.DatetimeIndex(["2026-08-17"])
    )

    signal, execution = report.report_market_dates(pd.Timestamp("2026-08-17"), calendar)

    assert signal == pd.Timestamp("2026-08-14")
    assert execution == pd.Timestamp("2026-08-17")


def test_weekend_report_is_rejected() -> None:
    calendar = pd.bdate_range("2026-08-03", "2026-08-17")

    with np.testing.assert_raises_regex(ValueError, "Monday through Friday"):
        report.report_market_dates(pd.Timestamp("2026-08-16"), calendar)


def test_daily_ranking_does_not_use_future_prices() -> None:
    data = _market_data()
    signal = data.calendar[-5]
    before = report.build_daily_ranking(data, signal).set_index("ticker")["score"]
    changed = copy.deepcopy(data)
    changed.close.loc[changed.close.index > signal, "H"] *= 50

    after = report.build_daily_ranking(changed, signal).set_index("ticker")["score"]

    pd.testing.assert_series_equal(before, after)


def test_device_payload_keeps_user_state_out_of_the_server_artifact() -> None:
    data = _market_data()
    report_date = data.calendar[-1]

    payload = report.build_device_payload(data, report_date)

    assert payload["default_capital"] == 2_819.0
    assert len(payload["selection"]) == 5
    assert np.isclose(sum(item["weight"] for item in payload["selection"]), 1.0)
    assert payload["privacy"] == {
        "storage": "browser localStorage only",
        "server_user_state": False,
        "cross_device_sync": False,
        "analytics": False,
    }
    assert "holdings" not in payload


def test_morning_payload_can_use_latest_completed_session() -> None:
    data = _market_data()
    report_date = data.calendar[-1] + pd.offsets.BDay(1)

    payload = report.build_device_payload(
        data, report_date, allow_stale_preview=True
    )

    assert payload["report_date_kst"] == str(report_date.date())
    assert payload["signal_market_date"] == str(data.calendar[-1].date())
    assert payload["stale_preview"] is True
