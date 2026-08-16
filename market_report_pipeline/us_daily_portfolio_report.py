"""Build the public weekday portfolio-decision payload from the local market cache.

The recommendation policy is ported from the standalone stock-rank project, but
this module depends only on files and packages in this repository. Personal
holdings are deliberately excluded; the browser keeps them in localStorage.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .io_utils import write_json
from .support import STOCK_CACHE, UNIVERSE_CACHE, safe_symbol


SCHEMA_VERSION = 1
DEFAULT_USER_CAPITAL = 2_819.0
MAX_POSITIONS = 5
HOLD_RANK = 10
MAX_NAMES_PER_SECTOR = 2
MAX_PAIRWISE_CORRELATION = 0.80
MINIMUM_PRICE = 10.0
MINIMUM_DOLLAR_VOLUME = 25_000_000.0
MAXIMUM_ANNUALIZED_VOLATILITY = 0.80
TOP_LIQUID_NAMES = 200
STOP_LOSS = 0.12
TRAILING_STOP = 0.15
DRIFT_THRESHOLD = 0.03
BENCHMARK_TICKER = "IVV"


@dataclass
class MarketData:
    calendar: pd.DatetimeIndex
    close: pd.DataFrame
    dollar_volume: pd.DataFrame
    universe: pd.DataFrame
    benchmark: pd.Series
    snapshot_path: Path


def _read_price(path: Path, ticker: str) -> pd.DataFrame:
    frame = pd.read_parquet(path)
    required = {"date", "close", "volume"}
    if not required.issubset(frame.columns):
        return pd.DataFrame()
    result = frame[["date", "close", "volume"]].copy()
    result["date"] = pd.to_datetime(result["date"])
    result["ticker"] = ticker
    return result.dropna(subset=["date", "close"]).sort_values("date")


def load_market_data() -> MarketData:
    """Load the cache produced by this repository's market-report collector."""

    snapshots = sorted(UNIVERSE_CACHE.glob("sp500_*.parquet"))
    if not snapshots:
        raise FileNotFoundError("S&P 500 universe snapshot is missing")
    snapshot_path = snapshots[-1]
    universe = pd.read_parquet(snapshot_path).copy()
    universe["ticker"] = universe["ticker"].astype(str).str.upper()

    rows: list[pd.DataFrame] = []
    for ticker in sorted(universe["ticker"].unique()):
        path = STOCK_CACHE / f"{safe_symbol(ticker)}.parquet"
        if not path.exists():
            continue
        frame = _read_price(path, ticker)
        if not frame.empty:
            rows.append(frame)
    if not rows:
        raise RuntimeError("Cached US stock prices are unavailable")

    prices = pd.concat(rows, ignore_index=True).drop_duplicates(
        ["date", "ticker"], keep="last"
    )
    close = prices.pivot(index="date", columns="ticker", values="close").sort_index()
    volume = prices.pivot(index="date", columns="ticker", values="volume").reindex(
        close.index
    )

    benchmark_path = STOCK_CACHE / f"{safe_symbol(BENCHMARK_TICKER)}.parquet"
    if not benchmark_path.exists():
        raise FileNotFoundError("Cached IVV history is required")
    benchmark = _read_price(benchmark_path, BENCHMARK_TICKER).set_index("date")[
        "close"
    ].sort_index()
    calendar = pd.DatetimeIndex(benchmark.index.unique()).sort_values()
    close = close.reindex(calendar)
    dollar_volume = (close * volume.reindex(calendar)).astype("float64")
    return MarketData(
        calendar=calendar,
        close=close.astype("float64"),
        dollar_volume=dollar_volume,
        universe=universe,
        benchmark=benchmark.astype("float64"),
        snapshot_path=snapshot_path,
    )


def report_market_dates(
    report_date: pd.Timestamp, calendar: pd.DatetimeIndex
) -> tuple[pd.Timestamp, pd.Timestamp]:
    """Map a 07:30 KST weekday report to signal and proposed execution dates."""

    report_date = pd.Timestamp(report_date).normalize()
    if report_date.dayofweek >= 5:
        raise ValueError("Reports are generated only Monday through Friday (KST)")
    completed = calendar[calendar < report_date]
    executable = calendar[calendar >= report_date]
    if completed.empty or executable.empty:
        raise ValueError(f"No cached US session can bracket report date {report_date.date()}")
    return pd.Timestamp(completed[-1]), pd.Timestamp(executable[0])


def members_on_date(data: MarketData, _signal_date: pd.Timestamp) -> set[str]:
    """Use the collected current S&P 500 snapshot for the live daily report."""

    return set(data.universe["ticker"].astype(str))


def build_daily_ranking(data: MarketData, signal_date: pd.Timestamp) -> pd.DataFrame:
    """Rank stable, liquid momentum candidates without using future prices."""

    history = data.close.loc[:signal_date]
    liquidity = data.dollar_volume.loc[:signal_date]
    if len(history) < 253 or signal_date not in history.index:
        raise ValueError("At least 253 completed sessions are required")
    latest = history.iloc[-1]
    returns = history.pct_change(fill_method=None)
    frame = pd.DataFrame(index=history.columns)
    frame["close"] = latest
    frame["mom_12_1"] = history.iloc[-22] / history.iloc[-253] - 1
    frame["mom_6_1"] = history.iloc[-22] / history.iloc[-127] - 1
    frame["vol_63"] = returns.tail(63).std() * math.sqrt(252)
    frame["sma_200"] = history.tail(200).mean()
    frame["trend_200"] = frame["close"] / frame["sma_200"] - 1
    frame["adv_63"] = liquidity.tail(63).mean()
    frame.index.name = "ticker"
    frame = frame.loc[frame.index.isin(members_on_date(data, signal_date))]
    frame = frame.dropna(
        subset=["close", "mom_12_1", "mom_6_1", "vol_63", "trend_200", "adv_63"]
    )
    frame = frame.loc[
        frame["close"].ge(MINIMUM_PRICE)
        & frame["adv_63"].ge(MINIMUM_DOLLAR_VOLUME)
        & frame["vol_63"].le(MAXIMUM_ANNUALIZED_VOLATILITY)
    ]
    frame = frame.nlargest(TOP_LIQUID_NAMES, "adv_63").copy()
    if len(frame) < MAX_POSITIONS:
        raise RuntimeError("Fewer than five stable/liquid candidates passed the screen")

    frame["rank_mom_12_1"] = frame["mom_12_1"].rank(pct=True, method="average")
    frame["rank_mom_6_1"] = frame["mom_6_1"].rank(pct=True, method="average")
    frame["rank_trend_200"] = frame["trend_200"].rank(pct=True, method="average")
    frame["rank_low_vol_63"] = (-frame["vol_63"]).rank(
        pct=True, method="average"
    )
    frame["score"] = (
        0.50 * frame["rank_mom_12_1"]
        + 0.25 * frame["rank_mom_6_1"]
        + 0.15 * frame["rank_trend_200"]
        + 0.10 * frame["rank_low_vol_63"]
    )
    metadata = data.universe.drop_duplicates("ticker").set_index("ticker")
    frame["name"] = metadata["name"].reindex(frame.index).fillna(frame.index.to_series())
    frame["sector"] = metadata["sector"].reindex(frame.index).fillna("Unknown")
    frame = frame.sort_values(["score", "adv_63"], ascending=[False, False])
    frame["rank"] = np.arange(1, len(frame) + 1)
    return frame.reset_index()


def _pairwise_ok(
    data: MarketData, signal_date: pd.Timestamp, ticker: str, selected: list[str]
) -> bool:
    if not selected:
        return True
    returns = (
        data.close.loc[:signal_date, selected + [ticker]]
        .tail(127)
        .pct_change(fill_method=None)
    )
    correlations = returns[selected].corrwith(returns[ticker])
    return bool(correlations.dropna().le(MAX_PAIRWISE_CORRELATION).all())


def select_portfolio(
    ranking: pd.DataFrame, data: MarketData, signal_date: pd.Timestamp
) -> list[str]:
    """Select five names with sector and pairwise-correlation limits."""

    indexed = ranking.set_index("ticker")
    selected: list[str] = []
    sector_counts: dict[str, int] = {}
    for ticker in ranking["ticker"].astype(str):
        sector = str(indexed.loc[ticker, "sector"])
        if sector_counts.get(sector, 0) >= MAX_NAMES_PER_SECTOR:
            continue
        if not _pairwise_ok(data, signal_date, ticker, selected):
            continue
        selected.append(ticker)
        sector_counts[sector] = sector_counts.get(sector, 0) + 1
        if len(selected) == MAX_POSITIONS:
            break
    if len(selected) < MAX_POSITIONS:
        for ticker in ranking["ticker"].astype(str):
            if ticker in selected:
                continue
            sector = str(indexed.loc[ticker, "sector"])
            if sector_counts.get(sector, 0) >= MAX_NAMES_PER_SECTOR:
                continue
            selected.append(ticker)
            sector_counts[sector] = sector_counts.get(sector, 0) + 1
            if len(selected) == MAX_POSITIONS:
                break
    if len(selected) != MAX_POSITIONS:
        raise RuntimeError("The public report requires exactly five selected names")
    return selected


def build_device_payload(
    data: MarketData,
    report_date: pd.Timestamp,
    *,
    default_capital: float = DEFAULT_USER_CAPITAL,
    allow_stale_preview: bool = False,
) -> dict[str, Any]:
    """Build public model data without reading or writing a user portfolio."""

    report_date = pd.Timestamp(report_date).normalize()
    stale_preview = False
    try:
        signal_date, execution_date = report_market_dates(report_date, data.calendar)
    except ValueError:
        if not allow_stale_preview or report_date.dayofweek >= 5:
            raise
        completed = data.calendar[data.calendar < report_date]
        if completed.empty:
            raise ValueError("No completed US session is available for the preview")
        signal_date = pd.Timestamp(completed[-1])
        execution_date = report_date
        stale_preview = True

    ranking = build_daily_ranking(data, signal_date)
    selected = select_portfolio(ranking, data, signal_date)
    ranked = ranking.set_index("ticker")
    metadata = data.universe.drop_duplicates("ticker").set_index("ticker")
    history = data.close.loc[:signal_date]
    latest = history.iloc[-1]
    sma_200 = history.tail(200).mean()
    quotes: dict[str, dict[str, Any]] = {}
    for ticker, close_value in latest.dropna().items():
        name = metadata["name"].get(ticker, ticker) if "name" in metadata else ticker
        sector = (
            metadata["sector"].get(ticker, "Unknown")
            if "sector" in metadata
            else "Unknown"
        )
        trend = float(close_value / sma_200.get(ticker, np.nan) - 1)
        quotes[str(ticker)] = {
            "ticker": str(ticker),
            "name": str(name),
            "sector": str(sector),
            "close": float(close_value),
            "rank": int(ranked.loc[ticker, "rank"]) if ticker in ranked.index else None,
            "trend_200": trend if math.isfinite(trend) else None,
        }

    benchmark_history = data.benchmark.loc[:signal_date]
    benchmark_close = float(benchmark_history.iloc[-1])
    benchmark_sma = float(benchmark_history.tail(200).mean())
    benchmark_gap = benchmark_close / benchmark_sma - 1
    market_state = (
        "강세"
        if benchmark_gap >= 0.05
        else ("상승 우위" if benchmark_gap > 0.01 else ("경계" if benchmark_gap >= -0.01 else "약세"))
    )
    selection = [
        {
            "ticker": ticker,
            "name": str(ranked.loc[ticker, "name"]),
            "sector": str(ranked.loc[ticker, "sector"]),
            "weight": 1 / MAX_POSITIONS,
            "reference_close": float(ranked.loc[ticker, "close"]),
            "rank": int(ranked.loc[ticker, "rank"]),
            "trend_200": float(ranked.loc[ticker, "trend_200"]),
        }
        for ticker in selected
    ]
    candidates = [
        {
            "ticker": str(row.ticker),
            "name": str(row.name),
            "sector": str(row.sector),
            "rank": int(row.rank),
            "score": float(row.score),
            "close": float(row.close),
            "trend_200": float(row.trend_200),
        }
        for row in ranking.itertuples(index=False)
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": pd.Timestamp.now(tz="Asia/Seoul").isoformat(),
        "report_date_kst": str(report_date.date()),
        "report_time_kst": "07:30",
        "signal_market_date": str(signal_date.date()),
        "proposed_execution_date": str(execution_date.date()),
        "stale_preview": stale_preview,
        "default_capital": float(default_capital),
        "default_fractional_shares": True,
        "fractional_precision": 3,
        "selection": selection,
        "candidates": candidates,
        "quotes": quotes,
        "market": {
            "state": market_state,
            "ivv_close": benchmark_close,
            "ivv_vs_sma_200": benchmark_gap,
        },
        "policy": {
            "maximum_positions": MAX_POSITIONS,
            "hold_rank": HOLD_RANK,
            "stop_loss": STOP_LOSS,
            "trailing_stop": TRAILING_STOP,
            "drift_threshold": DRIFT_THRESHOLD,
            "review_frequency": "first KST weekday report of each month",
            "automatic_trading": False,
        },
        "privacy": {
            "storage": "browser localStorage only",
            "server_user_state": False,
            "cross_device_sync": False,
            "analytics": False,
        },
        "data_snapshot": data.snapshot_path.name,
    }


def upload_r2(path: Path, bucket: str) -> None:
    from .publish_market_report_web import _r2_client

    client = _r2_client()
    body = path.read_bytes()
    object_key = "portfolio-reports/latest.json"
    client.put_object(
        Bucket=bucket,
        Key=object_key,
        Body=body,
        ContentType="application/json; charset=utf-8",
        CacheControl="public, max-age=60, stale-while-revalidate=3600",
    )
    metadata = client.head_object(Bucket=bucket, Key=object_key)
    if int(metadata.get("ContentLength", -1)) != len(body):
        raise RuntimeError(f"R2 upload verification failed: {object_key}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", type=pd.Timestamp, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--default-capital", type=float, default=DEFAULT_USER_CAPITAL)
    parser.add_argument("--allow-stale-preview", action="store_true")
    parser.add_argument("--upload-r2", action="store_true")
    parser.add_argument("--r2-bucket", default=os.environ.get("R2_BUCKET_NAME", "closeprice"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = build_device_payload(
        load_market_data(),
        args.as_of,
        default_capital=float(args.default_capital),
        allow_stale_preview=bool(args.allow_stale_preview),
    )
    output = args.output.resolve()
    write_json(payload, output)
    if args.upload_r2:
        upload_r2(output, args.r2_bucket)
    print(
        json.dumps(
            {
                "report_date": payload["report_date_kst"],
                "selection": [item["ticker"] for item in payload["selection"]],
                "output": str(output),
                "r2_uploaded": bool(args.upload_r2),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
