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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

from .io_utils import write_json
from .support import PROJECT_ROOT, STOCK_CACHE, UNIVERSE_CACHE, safe_symbol


SCHEMA_VERSION = 2
DEFAULT_USER_CAPITAL = 2_819.0
STRATEGY_CONFIG_PATH = PROJECT_ROOT / "config" / "portfolio-report.yaml"
MARKET_CONFIG_PATH = PROJECT_ROOT / "config" / "market-report.yaml"


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return yaml.safe_load(file) or {}


STRATEGY_CONFIG = _load_yaml(STRATEGY_CONFIG_PATH)
STRATEGY_ID = str(STRATEGY_CONFIG["strategy"]["id"])
STRATEGY_NAME = str(STRATEGY_CONFIG["strategy"]["name"])
BASE_WEIGHT = float(STRATEGY_CONFIG["score"]["base_weight"])
THEME_WEIGHT = float(STRATEGY_CONFIG["score"]["theme_weight"])
UNMAPPED_THEME_SCORE = float(STRATEGY_CONFIG["score"]["unmapped_theme_score"])
BASE_COMPONENT_WEIGHTS = {
    str(key): float(value)
    for key, value in STRATEGY_CONFIG["score"]["base_components"].items()
}
THEME_COMPONENT_WEIGHTS = {
    str(key): float(value)
    for key, value in STRATEGY_CONFIG["score"]["theme_components"].items()
}
MAX_POSITIONS = int(STRATEGY_CONFIG["portfolio"]["maximum_positions"])
TARGET_WEIGHT_EACH = float(STRATEGY_CONFIG["portfolio"]["target_weight_each"])
HOLD_RANK = int(STRATEGY_CONFIG["portfolio"]["hold_rank"])
MAX_NAMES_PER_SECTOR = int(STRATEGY_CONFIG["portfolio"]["maximum_names_per_sector"])
MAX_PAIRWISE_CORRELATION = float(STRATEGY_CONFIG["portfolio"]["maximum_pairwise_correlation"])
CORRELATION_LOOKBACK = int(STRATEGY_CONFIG["portfolio"]["correlation_lookback_sessions"])
MINIMUM_PRICE = float(STRATEGY_CONFIG["universe"]["minimum_price"])
MINIMUM_DOLLAR_VOLUME = float(STRATEGY_CONFIG["universe"]["minimum_dollar_volume_63"])
MAXIMUM_ANNUALIZED_VOLATILITY = float(STRATEGY_CONFIG["universe"]["maximum_annualized_volatility"])
TOP_LIQUID_NAMES = int(STRATEGY_CONFIG["universe"]["top_liquid_names"])
STOP_LOSS = float(STRATEGY_CONFIG["risk"]["stop_loss"])
TRAILING_STOP = float(STRATEGY_CONFIG["risk"]["trailing_stop"])
DRIFT_THRESHOLD = float(STRATEGY_CONFIG["portfolio"]["drift_threshold"])

if not math.isclose(BASE_WEIGHT + THEME_WEIGHT, 1.0):
    raise ValueError("Hybrid base and theme weights must sum to 1.0")
if not math.isclose(sum(BASE_COMPONENT_WEIGHTS.values()), 1.0):
    raise ValueError("Base score component weights must sum to 1.0")
if not math.isclose(sum(THEME_COMPONENT_WEIGHTS.values()), 1.0):
    raise ValueError("Theme score component weights must sum to 1.0")
if not math.isclose(MAX_POSITIONS * TARGET_WEIGHT_EACH, 1.0):
    raise ValueError("Maximum positions and target weight must allocate 100%")


@dataclass
class MarketData:
    calendar: pd.DatetimeIndex
    close: pd.DataFrame
    dollar_volume: pd.DataFrame
    universe: pd.DataFrame
    benchmark: pd.Series
    snapshot_path: Path
    theme_proxy_close: pd.DataFrame = field(default_factory=pd.DataFrame)
    theme_definitions: dict[str, dict[str, Any]] = field(default_factory=dict)


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

    benchmark_path = STOCK_CACHE / f"{safe_symbol('IVV')}.parquet"
    if not benchmark_path.exists():
        raise FileNotFoundError("Cached IVV history is required")
    benchmark = _read_price(benchmark_path, "IVV").set_index("date")[
        "close"
    ].sort_index()
    calendar = pd.DatetimeIndex(benchmark.index.unique()).sort_values()
    close = close.reindex(calendar)
    dollar_volume = (close * volume.reindex(calendar)).astype("float64")

    market_config = _load_yaml(MARKET_CONFIG_PATH)
    theme_definitions = {
        str(theme): definition
        for theme, definition in market_config.get("themes", {}).items()
    }
    proxy_series: dict[str, pd.Series] = {}
    missing_proxies: list[str] = []
    for definition in theme_definitions.values():
        proxy = str(definition["proxy"]).upper()
        proxy_path = STOCK_CACHE / f"{safe_symbol(proxy)}.parquet"
        if not proxy_path.exists():
            missing_proxies.append(proxy)
            continue
        proxy_frame = _read_price(proxy_path, proxy)
        if proxy_frame.empty:
            missing_proxies.append(proxy)
            continue
        proxy_series[proxy] = proxy_frame.set_index("date")["close"].astype(float)
    if missing_proxies:
        missing = ", ".join(sorted(set(missing_proxies)))
        raise FileNotFoundError(
            f"Cached theme proxy history is required for {STRATEGY_ID}: {missing}. "
            "Run the market report collection before the portfolio report."
        )
    theme_proxy_close = pd.DataFrame(proxy_series).reindex(calendar).ffill()
    return MarketData(
        calendar=calendar,
        close=close.astype("float64"),
        dollar_volume=dollar_volume,
        universe=universe,
        benchmark=benchmark.astype("float64"),
        snapshot_path=snapshot_path,
        theme_proxy_close=theme_proxy_close,
        theme_definitions=theme_definitions,
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


def build_theme_strength(
    data: MarketData, signal_date: pd.Timestamp
) -> tuple[pd.DataFrame, dict[str, list[str]]]:
    """Rank theme proxies using only prices known on the signal date."""

    ticker_themes: dict[str, list[str]] = {}
    for theme, definition in data.theme_definitions.items():
        for ticker in definition.get("members", []):
            ticker_themes.setdefault(str(ticker).upper(), []).append(str(theme))
    if not data.theme_definitions or data.theme_proxy_close.empty:
        return pd.DataFrame(), ticker_themes

    benchmark = data.benchmark.reindex(data.calendar).ffill().loc[:signal_date]
    rows: list[dict[str, Any]] = []
    for theme, definition in data.theme_definitions.items():
        proxy = str(definition["proxy"]).upper()
        if proxy not in data.theme_proxy_close:
            continue
        close = data.theme_proxy_close[proxy].loc[:signal_date].ffill()
        if signal_date not in close.index or len(close) < 61 or len(benchmark) < 61:
            continue
        rows.append(
            {
                "theme": str(theme),
                "proxy": proxy,
                "relative_5": close.pct_change(5, fill_method=None).loc[signal_date]
                - benchmark.pct_change(5, fill_method=None).loc[signal_date],
                "relative_20": close.pct_change(20, fill_method=None).loc[signal_date]
                - benchmark.pct_change(20, fill_method=None).loc[signal_date],
                "relative_60": close.pct_change(60, fill_method=None).loc[signal_date]
                - benchmark.pct_change(60, fill_method=None).loc[signal_date],
                "above_ma_50": float(
                    close.loc[signal_date] > close.rolling(50).mean().loc[signal_date]
                ),
            }
        )
    result = pd.DataFrame(rows)
    if result.empty:
        return result, ticker_themes
    result["theme_strength"] = 0.0
    for column, weight in THEME_COMPONENT_WEIGHTS.items():
        result["theme_strength"] += float(weight) * result[column].rank(pct=True)
    return (
        result.sort_values(["theme_strength", "theme"], ascending=[False, True]),
        ticker_themes,
    )


def build_daily_ranking(data: MarketData, signal_date: pd.Timestamp) -> pd.DataFrame:
    """Build the versioned stable-momentum/theme hybrid score without look-ahead."""

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
    frame["base_score"] = (
        BASE_COMPONENT_WEIGHTS["momentum_12_1"] * frame["rank_mom_12_1"]
        + BASE_COMPONENT_WEIGHTS["momentum_6_1"] * frame["rank_mom_6_1"]
        + BASE_COMPONENT_WEIGHTS["trend_200"] * frame["rank_trend_200"]
        + BASE_COMPONENT_WEIGHTS["low_volatility_63"] * frame["rank_low_vol_63"]
    )
    theme_strength, ticker_themes = build_theme_strength(data, signal_date)
    theme_lookup = (
        theme_strength.set_index("theme")["theme_strength"].to_dict()
        if not theme_strength.empty
        else {}
    )

    def mapped_theme_score(ticker: str) -> float:
        values = [
            theme_lookup.get(theme, np.nan)
            for theme in ticker_themes.get(str(ticker).upper(), [])
        ]
        usable = [float(value) for value in values if pd.notna(value)]
        return max(usable) if usable else UNMAPPED_THEME_SCORE

    frame["theme_strength"] = frame.index.to_series().map(mapped_theme_score)
    frame["themes"] = frame.index.to_series().map(
        lambda ticker: ", ".join(ticker_themes.get(str(ticker).upper(), [])) or "미분류"
    )
    frame["theme_mapped"] = frame.index.to_series().map(
        lambda ticker: bool(ticker_themes.get(str(ticker).upper(), []))
    )
    frame["score"] = BASE_WEIGHT * frame["base_score"] + THEME_WEIGHT * frame["theme_strength"]
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
        .tail(CORRELATION_LOOKBACK)
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
            "themes": str(ranked.loc[ticker, "themes"]) if ticker in ranked.index else "미분류",
            "score": float(ranked.loc[ticker, "score"]) if ticker in ranked.index else None,
            "base_score": float(ranked.loc[ticker, "base_score"]) if ticker in ranked.index else None,
            "theme_strength": float(ranked.loc[ticker, "theme_strength"]) if ticker in ranked.index else None,
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
            "themes": str(ranked.loc[ticker, "themes"]),
            "weight": TARGET_WEIGHT_EACH,
            "reference_close": float(ranked.loc[ticker, "close"]),
            "rank": int(ranked.loc[ticker, "rank"]),
            "score": float(ranked.loc[ticker, "score"]),
            "base_score": float(ranked.loc[ticker, "base_score"]),
            "theme_strength": float(ranked.loc[ticker, "theme_strength"]),
            "trend_200": float(ranked.loc[ticker, "trend_200"]),
        }
        for ticker in selected
    ]
    candidates = [
        {
            "ticker": str(row.ticker),
            "name": str(row.name),
            "sector": str(row.sector),
            "themes": str(row.themes),
            "rank": int(row.rank),
            "score": float(row.score),
            "base_score": float(row.base_score),
            "theme_strength": float(row.theme_strength),
            "close": float(row.close),
            "trend_200": float(row.trend_200),
        }
        for row in ranking.itertuples(index=False)
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "report_date_kst": str(report_date.date()),
        "report_time_kst": "07:30",
        "signal_market_date": str(signal_date.date()),
        "proposed_execution_date": str(execution_date.date()),
        "stale_preview": stale_preview,
        "default_capital": float(default_capital),
        "default_fractional_shares": True,
        "fractional_precision": 3,
        "strategy": {
            "id": STRATEGY_ID,
            "name": STRATEGY_NAME,
            "status": str(STRATEGY_CONFIG["strategy"]["status"]),
            "base_weight": BASE_WEIGHT,
            "theme_weight": THEME_WEIGHT,
            "benchmark": str(STRATEGY_CONFIG["strategy"]["benchmark"]),
        },
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
            "maximum_names_per_sector": MAX_NAMES_PER_SECTOR,
            "maximum_pairwise_correlation": MAX_PAIRWISE_CORRELATION,
            "stop_loss": STOP_LOSS,
            "trailing_stop": TRAILING_STOP,
            "drift_threshold": DRIFT_THRESHOLD,
            "review_frequency": "first KST weekday report of each month",
            "market_regime_cash_overlay": bool(
                STRATEGY_CONFIG["risk"]["market_regime_cash_overlay"]
            ),
            "stopped_capital_stays_cash_until_monthly_review": bool(
                STRATEGY_CONFIG["risk"]["stopped_capital_stays_cash_until_monthly_review"]
            ),
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
