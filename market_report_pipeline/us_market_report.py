"""Post-close US market intelligence report.

This module is intentionally separate from portfolio construction.  It answers
top-down questions: market regime, breadth, sector/theme leadership, leader stocks,
chart phase, macro releases, rates, and sourced news.  It never creates orders.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import shutil
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd
import requests
import yaml

from .support import (
    FRED_GRAPH_URL,
    PROJECT_ROOT,
    STOCK_CACHE,
    _download_yahoo_frame,
    _read_fred_response,
    fetch_sp500_snapshot,
    safe_symbol,
)
from .us_market_html_report import (
    build_macro_axes,
    build_news_clusters,
    build_transmission_signals,
    render_market_html,
)
from .io_utils import atomic_write_csv, atomic_write_parquet, write_json


LOGGER = logging.getLogger(__name__)
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "market-report.yaml"
RESULTS_ROOT = PROJECT_ROOT / "data" / "results"
MARKET_RAW_ROOT = PROJECT_ROOT / "data" / "raw" / "us_market"
MACRO_CACHE = MARKET_RAW_ROOT / "fred_market_macro.parquet"
NEWS_CACHE_ROOT = MARKET_RAW_ROOT / "news"

SECTOR_DISPLAY_NAMES = {
    "Communication Services": "커뮤니케이션 서비스 (Communication Services)",
    "Consumer Discretionary": "경기소비재 (Consumer Discretionary)",
    "Consumer Staples": "필수소비재 (Consumer Staples)",
    "Energy": "에너지 (Energy)",
    "Financials": "금융 (Financials)",
    "Health Care": "건강관리 (Health Care)",
    "Industrials": "산업재 (Industrials)",
    "Information Technology": "정보기술 (Information Technology)",
    "Materials": "소재 (Materials)",
    "Real Estate": "부동산 (Real Estate)",
    "Utilities": "유틸리티 (Utilities)",
}

LEGACY_RESULT_FILES = [
    "DAILY_REPORT.md",
    "IMPLEMENTATION_AND_RESULTS.md",
    "backtest_equity_and_drawdown.png",
    "backtest_equity_curve.csv",
    "backtest_metrics.json",
    "backtest_transactions.csv",
    "config_snapshot.json",
    "current_rankings.csv",
    "current_sec_fundamentals.csv",
    "data_quality.json",
    "feature_importance.csv",
    "legacy_qlib_benchmarks.json",
    "market_regime.json",
    "portfolio_actions.csv",
    "run_manifest.json",
    "stable_candidate_universe.csv",
    "weekly_decisions.csv",
]


@dataclass(frozen=True)
class MarketRunSettings:
    as_of: pd.Timestamp
    history_start: pd.Timestamp
    output_dir: Path
    config_path: Path
    refresh: bool = False


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        result = yaml.safe_load(file)
    if not isinstance(result, dict):
        raise ValueError(f"Invalid market-report config: {path}")
    return result


def _write_text_atomic(text: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def archive_legacy_reports(results_root: Path) -> dict[str, Any]:
    """Move the former mixed-purpose outputs under explicit `_old` locations."""

    moved: list[dict[str, str]] = []
    latest = results_root / "LATEST_REPORT.md"
    latest_old = results_root / "LATEST_REPORT_old.md"
    if latest.exists() and not latest_old.exists():
        latest.replace(latest_old)
        moved.append({"from": str(latest), "to": str(latest_old)})
    for directory in results_root.iterdir() if results_root.exists() else []:
        if not directory.is_dir() or directory.name == "_old":
            continue
        old_directory = directory / "_old"
        for name in LEGACY_RESULT_FILES:
            source = directory / name
            if not source.exists():
                continue
            old_directory.mkdir(parents=True, exist_ok=True)
            target = old_directory / name
            if target.exists():
                target = old_directory / f"{source.stem}_old{source.suffix}"
            source.replace(target)
            moved.append({"from": str(source), "to": str(target)})
    return {"moved_count": len(moved), "moved": moved}


def _expected_market_date(as_of: pd.Timestamp) -> pd.Timestamp:
    result = as_of.normalize()
    if result.weekday() == 5:
        result -= pd.Timedelta(days=1)
    elif result.weekday() == 6:
        result -= pd.Timedelta(days=2)
    return result


def _merge_cache(existing: pd.DataFrame, update: pd.DataFrame) -> pd.DataFrame:
    result = pd.concat([existing, update], ignore_index=True)
    result["date"] = pd.to_datetime(result["date"]).astype("datetime64[ns]")
    return result.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)


def collect_context_prices(
    symbols: list[str], settings: MarketRunSettings, config: dict[str, Any]
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Incrementally collect index, proxy, theme, and risk-asset daily prices."""

    data_cfg = config["data"]
    expected_latest = _expected_market_date(settings.as_of)
    STOCK_CACHE.mkdir(parents=True, exist_ok=True)

    def one(symbol: str) -> tuple[str, pd.DataFrame, bool]:
        target = STOCK_CACHE / f"{safe_symbol(symbol)}.parquet"
        cached = pd.read_parquet(target) if target.exists() else pd.DataFrame()
        if not cached.empty:
            cached["date"] = pd.to_datetime(cached["date"]).astype("datetime64[ns]")
        if not settings.refresh and not cached.empty and cached["date"].max() >= expected_latest:
            return symbol, cached.loc[cached["date"].ge(settings.history_start)].copy(), True
        request_start = settings.history_start
        if not settings.refresh and not cached.empty:
            request_start = max(
                settings.history_start,
                cached["date"].max() - pd.Timedelta(days=int(data_cfg["cache_overlap_days"])),
            )
        update = _download_yahoo_frame(
            symbol,
            request_start,
            settings.as_of + pd.Timedelta(days=1),
            timeout=int(data_cfg["request_timeout_seconds"]),
            max_retries=int(data_cfg["max_retries"]),
        )
        result = _merge_cache(cached, update) if not cached.empty else update
        result = result.loc[result["date"].between(settings.history_start, settings.as_of)]
        atomic_write_parquet(result, target)
        return symbol, result, not cached.empty

    frames: list[pd.DataFrame] = []
    failures: list[dict[str, str]] = []
    cache_hits = 0
    with ThreadPoolExecutor(max_workers=int(data_cfg["request_workers"])) as executor:
        futures = {executor.submit(one, symbol): symbol for symbol in sorted(set(symbols))}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                _, frame, cached = future.result()
                frames.append(frame)
                cache_hits += int(cached)
            except Exception as error:  # noqa: BLE001
                failures.append({"ticker": symbol, "error": str(error)})
    if not frames:
        raise RuntimeError("No context price series were collected.")
    result = pd.concat(frames, ignore_index=True)
    result["date"] = pd.to_datetime(result["date"]).astype("datetime64[ns]")
    audit = {
        "requested": len(set(symbols)),
        "successful": int(result["ticker"].nunique()),
        "failures": failures,
        "cache_hits": cache_hits,
        "start": result["date"].min(),
        "end": result["date"].max(),
        "rows": len(result),
        "duplicate_ticker_dates": int(result.duplicated(["ticker", "date"]).sum()),
    }
    return result, audit


def collect_fred_market_macro(
    settings: MarketRunSettings, config: dict[str, Any]
) -> tuple[pd.DataFrame, dict[str, Any]]:
    series = list(config["macro"]["fred_series"])
    if MACRO_CACHE.exists() and not settings.refresh:
        frame = pd.read_parquet(MACRO_CACHE)
        frame["date"] = pd.to_datetime(frame["date"])
        if set(series).issubset(frame.columns) and frame["date"].max() >= settings.as_of - pd.Timedelta(days=7):
            return frame, {
                "provider": "FRED graph CSV",
                "series": series,
                "cache_hit": True,
                "start": frame["date"].min(),
                "end": frame["date"].max(),
            }
    response = requests.get(
        FRED_GRAPH_URL,
        params={
            "id": ",".join(series),
            "cosd": (settings.history_start - pd.Timedelta(days=500)).strftime("%Y-%m-%d"),
            "coed": settings.as_of.strftime("%Y-%m-%d"),
        },
        timeout=30,
    )
    response.raise_for_status()
    raw = _read_fred_response(response)
    raw.index = pd.to_datetime(raw.index)
    raw = raw.loc[:, ~raw.columns.duplicated()].replace(".", np.nan).apply(pd.to_numeric, errors="coerce")
    frame = raw.reset_index().rename(columns={raw.index.name or "index": "date"})
    atomic_write_parquet(frame, MACRO_CACHE)
    return frame, {
        "provider": "FRED graph CSV",
        "series": series,
        "cache_hit": False,
        "start": frame["date"].min(),
        "end": frame["date"].max(),
    }


def _rsi(close: pd.Series, window: int = 14) -> float:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / window, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / window, adjust=False).mean()
    value = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    return float(value.iloc[-1]) if not value.empty else np.nan


def _chart_phase(frame: pd.DataFrame) -> str:
    close = frame["close"].dropna()
    if len(close) < 200:
        return "이력 부족"
    ma20, ma50, ma200 = (close.rolling(window).mean().iloc[-1] for window in (20, 50, 200))
    last = close.iloc[-1]
    rsi = _rsi(close)
    previous = close.shift(1)
    true_range = pd.concat(
        [
            frame["high"] - frame["low"],
            (frame["high"] - previous).abs(),
            (frame["low"] - previous).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr_ratio = true_range.rolling(14).mean().iloc[-1] / last
    distance20 = last / ma20 - 1
    breakout = last >= close.shift(1).rolling(55).max().iloc[-1] * 0.995
    if last < ma200 and ma20 < ma50:
        return "하락 추세"
    if ma20 > ma50 > ma200:
        if distance20 > max(0.10, 2.5 * atr_ratio) or rsi >= 75:
            return "과열 상승"
        if breakout and distance20 <= max(0.08, 2 * atr_ratio):
            return "돌파 초기"
        if last < ma20 and last >= ma50:
            return "상승 중 눌림"
        return "추세 진행"
    if last >= ma200 and ma50 >= ma200:
        return "상승 전환"
    if last >= ma200:
        return "반등 시도"
    return "기반 형성"


def instrument_snapshot(frame: pd.DataFrame, symbol: str, name: str) -> dict[str, Any]:
    group = frame.loc[frame["ticker"].eq(symbol)].sort_values("date").dropna(subset=["close"])
    if group.empty:
        raise ValueError(f"Missing price data for {symbol}")
    close = group["close"]
    volume = group["volume"]
    returns = close.pct_change(fill_method=None)
    ma20 = close.rolling(20).mean().iloc[-1]
    ma50 = close.rolling(50).mean().iloc[-1]
    ma200 = close.rolling(200).mean().iloc[-1]
    row: dict[str, Any] = {
        "name": name,
        "ticker": symbol,
        "date": group["date"].iloc[-1],
        "close": close.iloc[-1],
        "return_1d": close.pct_change(1, fill_method=None).iloc[-1],
        "return_5d": close.pct_change(5, fill_method=None).iloc[-1],
        "return_20d": close.pct_change(20, fill_method=None).iloc[-1],
        "return_60d": close.pct_change(60, fill_method=None).iloc[-1],
        "volatility_20d": returns.rolling(20).std().iloc[-1] * math.sqrt(252),
        "ma20_gap": close.iloc[-1] / ma20 - 1,
        "ma50_gap": close.iloc[-1] / ma50 - 1,
        "ma200_gap": close.iloc[-1] / ma200 - 1,
        "above_ma20": bool(close.iloc[-1] > ma20) if pd.notna(ma20) else np.nan,
        "above_ma50": bool(close.iloc[-1] > ma50) if pd.notna(ma50) else np.nan,
        "above_ma200": bool(close.iloc[-1] > ma200) if pd.notna(ma200) else np.nan,
        "ma50_observations": min(len(close), 50),
        "ma50_window_start": group["date"].iloc[-50] if len(group) >= 50 else pd.NaT,
        "ma50_window_end": group["date"].iloc[-1],
        "rsi14": _rsi(close),
        "volume_ratio_20": (
            volume.iloc[-1] / volume.rolling(20).mean().iloc[-1]
            if pd.notna(volume.rolling(20).mean().iloc[-1]) and volume.rolling(20).mean().iloc[-1] > 0
            else np.nan
        ),
        "average_dollar_volume_20": (close * volume).rolling(20).mean().iloc[-1],
        "range_52w_position": (close.iloc[-1] - close.rolling(252).min().iloc[-1])
        / (close.rolling(252).max().iloc[-1] - close.rolling(252).min().iloc[-1]),
        "chart_phase": _chart_phase(group),
    }
    return row


def build_stock_snapshots(prices: pd.DataFrame, universe: pd.DataFrame) -> pd.DataFrame:
    metadata = universe.set_index("ticker")
    rows: list[dict[str, Any]] = []
    for ticker in sorted(set(prices["ticker"]) & set(metadata.index)):
        try:
            row = instrument_snapshot(prices, ticker, str(metadata.loc[ticker, "name"]))
            row["sector"] = metadata.loc[ticker, "sector"]
            row["industry"] = metadata.loc[ticker, "industry"]
            rows.append(row)
        except (ValueError, IndexError):
            continue
    return pd.DataFrame(rows)


def audit_ma50_breadth(
    prices: pd.DataFrame,
    universe: pd.DataFrame,
    market_date: pd.Timestamp,
    sectors: pd.DataFrame,
    benchmark_ticker: str,
    periods: int = 50,
) -> dict[str, Any]:
    """Recompute sector breadth from raw closes and report its exact time window."""

    normalized_market_date = pd.Timestamp(market_date).normalize()
    universe_tickers = set(universe["ticker"].astype(str))
    history = prices.loc[
        prices["ticker"].isin(universe_tickers),
        ["date", "ticker", "close"],
    ].copy()
    history["date"] = pd.to_datetime(history["date"])
    history = history.loc[history["date"].le(normalized_market_date)]
    histories = {
        str(ticker): group.sort_values("date").dropna(subset=["close"])
        for ticker, group in history.groupby("ticker", observed=True)
    }
    rows: list[dict[str, Any]] = []
    for item in universe[["ticker", "sector"]].itertuples(index=False):
        group = histories.get(str(item.ticker), pd.DataFrame(columns=["date", "close"])).tail(periods)
        complete = len(group) == periods
        window_end = pd.to_datetime(group["date"]).max() if not group.empty else pd.NaT
        current = pd.notna(window_end) and pd.Timestamp(window_end).normalize() == normalized_market_date
        rows.append(
            {
                "ticker": str(item.ticker),
                "sector": str(item.sector),
                "observations": len(group),
                "window_start": pd.to_datetime(group["date"]).min() if complete else pd.NaT,
                "window_end": window_end,
                "eligible": complete and current,
                "above_ma50": (
                    bool(group["close"].iloc[-1] > group["close"].mean())
                    if complete and current
                    else np.nan
                ),
            }
        )

    audit_rows = pd.DataFrame(rows)
    eligible = audit_rows.loc[audit_rows["eligible"]].copy()
    recomputed = eligible.groupby("sector", observed=True)["above_ma50"].mean()
    published = sectors.set_index("sector")["above_ma50_breadth"]
    comparison = pd.concat(
        [recomputed.rename("recomputed"), published.rename("published")],
        axis=1,
    )
    comparison["difference"] = comparison["recomputed"] - comparison["published"]

    benchmark_history = prices.loc[
        prices["ticker"].eq(str(benchmark_ticker)),
        ["date", "close"],
    ].copy()
    benchmark_history["date"] = pd.to_datetime(benchmark_history["date"])
    benchmark = (
        benchmark_history.loc[benchmark_history["date"].le(normalized_market_date)]
        .sort_values("date")
        .dropna(subset=["close"])
        .tail(periods)
    )
    benchmark_complete = len(benchmark) == periods
    window_start = pd.to_datetime(benchmark["date"]).min() if benchmark_complete else pd.NaT
    window_end = pd.to_datetime(benchmark["date"]).max() if benchmark_complete else pd.NaT
    max_difference = comparison["difference"].abs().max()
    max_difference = None if pd.isna(max_difference) else float(max_difference)
    required_eligible = min(490, len(universe))
    passed = (
        benchmark_complete
        and len(eligible) >= required_eligible
        and max_difference is not None
        and max_difference <= 1e-12
    )
    return {
        "definition": "기준일 종가가 최근 50거래일 종가 평균보다 높은 종목의 비율",
        "periods": periods,
        "benchmark_ticker": str(benchmark_ticker),
        "window_start": window_start,
        "window_end": window_end,
        "calendar_days": (
            int((pd.Timestamp(window_end) - pd.Timestamp(window_start)).days + 1)
            if pd.notna(window_start) and pd.notna(window_end)
            else None
        ),
        "universe_count": len(universe),
        "price_series_count": len(audit_rows),
        "eligible_count": len(eligible),
        "required_eligible_count": required_eligible,
        "incomplete_count": int(audit_rows["observations"].lt(periods).sum()),
        "incomplete_tickers": audit_rows.loc[
            audit_rows["observations"].lt(periods),
            "ticker",
        ].tolist(),
        "stale_count": int(
            pd.to_datetime(audit_rows["window_end"], errors="coerce")
            .dt.normalize()
            .ne(normalized_market_date)
            .sum()
        ),
        "stale_tickers": audit_rows.loc[
            pd.to_datetime(audit_rows["window_end"], errors="coerce")
            .dt.normalize()
            .ne(normalized_market_date),
            "ticker",
        ].tolist(),
        "sector_max_abs_difference": max_difference,
        "passed": passed,
    }


def build_index_overview(
    prices: pd.DataFrame, config: dict[str, Any]
) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows: list[dict[str, Any]] = []
    for category, mapping in (
        ("주가지수", config["indices"]),
        ("위험·자산", config["risk_assets"]),
    ):
        for name, ticker in mapping.items():
            try:
                row = instrument_snapshot(prices, str(ticker), str(name))
                row["category"] = category
                rows.append(row)
            except (ValueError, IndexError):
                continue
    overview = pd.DataFrame(rows)
    index_rows = overview.loc[overview["category"].eq("주가지수")].copy()
    risk_rows = overview.loc[overview["category"].eq("위험·자산")].copy()
    return index_rows, risk_rows


def build_sector_leadership(
    stocks: pd.DataFrame,
    benchmark: pd.Series,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows: list[dict[str, Any]] = []
    leaders: list[dict[str, Any]] = []
    benchmark_returns = {window: float(benchmark[f"return_{window}d"]) for window in (1, 5, 20, 60)}
    for sector, group in stocks.groupby("sector", observed=True):
        eligible = group.loc[
            group["close"].ge(10) & group["average_dollar_volume_20"].ge(20_000_000)
        ].copy()
        if eligible.empty:
            eligible = group.copy()
        for column in ("return_20d", "return_60d", "volume_ratio_20", "range_52w_position"):
            eligible[f"_{column}_rank"] = eligible[column].rank(pct=True)
        eligible["leader_score"] = (
            0.35 * eligible["_return_20d_rank"]
            + 0.25 * eligible["_return_60d_rank"]
            + 0.20 * eligible["_volume_ratio_20_rank"]
            + 0.20 * eligible["_range_52w_position_rank"]
        )
        leader = eligible.sort_values("leader_score", ascending=False).iloc[0]
        leader_row = {
            "scope": "sector",
            "group": sector,
            "group_display": SECTOR_DISPLAY_NAMES.get(str(sector), str(sector)),
            "name": leader["name"],
            "ticker": leader["ticker"],
            "company_ticker": f"{leader['name']} ({leader['ticker']})",
            "leader_score": leader["leader_score"],
            "return_20d": leader["return_20d"],
            "return_60d": leader["return_60d"],
            "volume_ratio_20": leader["volume_ratio_20"],
            "chart_phase": leader["chart_phase"],
            "rsi14": leader["rsi14"],
            "ma20_gap": leader["ma20_gap"],
            "risk_note": _phase_risk_note(str(leader["chart_phase"])),
        }
        leaders.append(leader_row)
        row = {
            "sector": sector,
            "sector_display": SECTOR_DISPLAY_NAMES.get(str(sector), str(sector)),
            "constituents": len(group),
            "ma50_constituents": int(group["above_ma50"].notna().sum()),
            "return_1d": group["return_1d"].mean(),
            "return_5d": group["return_5d"].mean(),
            "return_20d": group["return_20d"].mean(),
            "return_60d": group["return_60d"].mean(),
            "relative_1d": group["return_1d"].mean() - benchmark_returns[1],
            "relative_5d": group["return_5d"].mean() - benchmark_returns[5],
            "relative_20d": group["return_20d"].mean() - benchmark_returns[20],
            "relative_60d": group["return_60d"].mean() - benchmark_returns[60],
            "positive_1d_breadth": group["return_1d"].gt(0).mean(),
            "above_ma20_breadth": group["above_ma20"].mean(),
            "above_ma50_breadth": group["above_ma50"].mean(),
            "above_ma200_breadth": group["above_ma200"].mean(),
            "average_volatility_20d": group["volatility_20d"].mean(),
            "leader": leader_row["company_ticker"],
            "leader_phase": leader_row["chart_phase"],
        }
        rows.append(row)
    result = pd.DataFrame(rows)
    for column in ("relative_5d", "relative_20d", "relative_60d", "above_ma50_breadth"):
        result[f"_{column}_rank"] = result[column].rank(pct=True)
    result["sector_score"] = 100 * (
        0.20 * result["_relative_5d_rank"]
        + 0.35 * result["_relative_20d_rank"]
        + 0.25 * result["_relative_60d_rank"]
        + 0.20 * result["_above_ma50_breadth_rank"]
    )
    result["leadership_quality"] = np.select(
        [
            result["above_ma50_breadth"].ge(0.60) & result["relative_20d"].gt(0),
            result["relative_20d"].gt(0) & result["above_ma50_breadth"].lt(0.45),
            result["relative_20d"].lt(0) & result["above_ma50_breadth"].lt(0.45),
        ],
        ["상승 확산", "소수 종목 집중", "약세 확산"],
        default="중립·혼조",
    )
    result = result.sort_values("sector_score", ascending=False).reset_index(drop=True)
    result["rank"] = np.arange(1, len(result) + 1)
    return result, pd.DataFrame(leaders).sort_values("leader_score", ascending=False)


def _phase_risk_note(phase: str) -> str:
    return {
        "돌파 초기": "돌파 실패와 거래량 둔화 확인",
        "추세 진행": "20일선 이탈 여부 확인",
        "과열 상승": "추격 위험; 이격 축소 대기",
        "상승 중 눌림": "50일선 지지 확인",
        "상승 전환": "장기 추세 확인 전 변동 가능",
        "반등 시도": "200일선 재이탈 위험",
        "하락 추세": "추세 회복 전 보수적 해석",
        "기반 형성": "방향 확정 전 관찰",
    }.get(phase, "가격 이력과 거래량 추가 확인")


def build_theme_leadership(
    prices: pd.DataFrame,
    universe: pd.DataFrame,
    benchmark: pd.Series,
    config: dict[str, Any],
) -> tuple[pd.DataFrame, pd.DataFrame]:
    universe_names = universe.set_index("ticker")["name"].to_dict()
    configured_names = {str(key): str(value) for key, value in config["symbol_names"].items()}
    rows: list[dict[str, Any]] = []
    leaders: list[dict[str, Any]] = []
    for theme, definition in config["themes"].items():
        proxy = str(definition["proxy"])
        try:
            proxy_row = instrument_snapshot(prices, proxy, f"{theme} proxy")
        except (ValueError, IndexError):
            continue
        members: list[dict[str, Any]] = []
        for ticker in definition["members"]:
            ticker = str(ticker)
            name = universe_names.get(ticker, configured_names.get(ticker, ticker))
            try:
                member = instrument_snapshot(prices, ticker, name)
            except (ValueError, IndexError):
                continue
            if (
                member["close"] < float(config["filters"]["min_price"])
                or member["average_dollar_volume_20"]
                < float(config["filters"]["min_average_dollar_volume_20"])
            ):
                continue
            members.append(member)
        member_frame = pd.DataFrame(members)
        if member_frame.empty:
            continue
        for column in ("return_20d", "return_60d", "volume_ratio_20", "range_52w_position"):
            member_frame[f"_{column}_rank"] = member_frame[column].rank(pct=True)
        member_frame["leader_score"] = (
            0.35 * member_frame["_return_20d_rank"]
            + 0.25 * member_frame["_return_60d_rank"]
            + 0.20 * member_frame["_volume_ratio_20_rank"]
            + 0.20 * member_frame["_range_52w_position_rank"]
        )
        leader = member_frame.sort_values("leader_score", ascending=False).iloc[0]
        leader_row = {
            "scope": "theme",
            "group": theme,
            "group_display": theme,
            "name": leader["name"],
            "ticker": leader["ticker"],
            "company_ticker": f"{leader['name']} ({leader['ticker']})",
            "leader_score": leader["leader_score"],
            "return_20d": leader["return_20d"],
            "return_60d": leader["return_60d"],
            "volume_ratio_20": leader["volume_ratio_20"],
            "chart_phase": leader["chart_phase"],
            "rsi14": leader["rsi14"],
            "ma20_gap": leader["ma20_gap"],
            "risk_note": _phase_risk_note(str(leader["chart_phase"])),
        }
        leaders.append(leader_row)
        rows.append(
            {
                "theme": theme,
                "proxy": proxy,
                "members_available": len(member_frame),
                "return_1d": proxy_row["return_1d"],
                "return_5d": proxy_row["return_5d"],
                "return_20d": proxy_row["return_20d"],
                "return_60d": proxy_row["return_60d"],
                "relative_5d": proxy_row["return_5d"] - benchmark["return_5d"],
                "relative_20d": proxy_row["return_20d"] - benchmark["return_20d"],
                "relative_60d": proxy_row["return_60d"] - benchmark["return_60d"],
                "above_ma50_breadth": member_frame["above_ma50"].mean(),
                "above_ma200_breadth": member_frame["above_ma200"].mean(),
                "positive_1d_breadth": member_frame["return_1d"].gt(0).mean(),
                "proxy_phase": proxy_row["chart_phase"],
                "leader": leader_row["company_ticker"],
                "leader_phase": leader_row["chart_phase"],
            }
        )
    result = pd.DataFrame(rows)
    for column in ("relative_5d", "relative_20d", "relative_60d", "above_ma50_breadth"):
        result[f"_{column}_rank"] = result[column].rank(pct=True)
    result["theme_score"] = 100 * (
        0.20 * result["_relative_5d_rank"]
        + 0.35 * result["_relative_20d_rank"]
        + 0.25 * result["_relative_60d_rank"]
        + 0.20 * result["_above_ma50_breadth_rank"]
    )
    result["leadership_quality"] = np.select(
        [
            result["above_ma50_breadth"].ge(0.60) & result["relative_20d"].gt(0),
            result["relative_20d"].gt(0) & result["above_ma50_breadth"].lt(0.45),
            result["relative_20d"].lt(0) & result["above_ma50_breadth"].lt(0.45),
        ],
        ["상승 확산", "대장주 집중", "약세 확산"],
        default="중립·혼조",
    )
    result = result.sort_values("theme_score", ascending=False).reset_index(drop=True)
    result["rank"] = np.arange(1, len(result) + 1)
    return result, pd.DataFrame(leaders).sort_values("leader_score", ascending=False)


def enrich_rotation_history(
    prices: pd.DataFrame,
    universe: pd.DataFrame,
    config: dict[str, Any],
    market_date: pd.Timestamp,
    sectors: pd.DataFrame,
    themes: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """Attach prior-session and five-session rank changes without look-ahead."""

    benchmark_ticker = str(config["indices"]["S&P 500"])
    dates = sorted(
        pd.to_datetime(
            prices.loc[
                prices["ticker"].eq(benchmark_ticker) & prices["date"].le(market_date),
                "date",
            ]
        ).dropna().unique()
    )
    references = {
        "1d": pd.Timestamp(dates[-2]) if len(dates) >= 2 else pd.NaT,
        "5d": pd.Timestamp(dates[-6]) if len(dates) >= 6 else pd.NaT,
    }
    history: dict[str, tuple[pd.DataFrame, pd.DataFrame]] = {}
    failures: list[dict[str, str]] = []
    for label, reference_date in references.items():
        if pd.isna(reference_date):
            continue
        try:
            historical_prices = prices.loc[prices["date"].le(reference_date)].copy()
            historical_stocks = build_stock_snapshots(historical_prices, universe)
            historical_indices, _ = build_index_overview(historical_prices, config)
            benchmark_rows = historical_indices.loc[historical_indices["name"].eq("S&P 500")]
            if benchmark_rows.empty:
                raise RuntimeError("S&P 500 benchmark is missing")
            historical_sectors, _ = build_sector_leadership(
                historical_stocks,
                benchmark_rows.iloc[0],
            )
            historical_themes, _ = build_theme_leadership(
                historical_prices,
                universe,
                benchmark_rows.iloc[0],
                config,
            )
            history[label] = (historical_sectors, historical_themes)
        except Exception as error:  # noqa: BLE001
            failures.append({"period": label, "date": str(reference_date), "error": str(error)})

    def attach(
        current: pd.DataFrame,
        key: str,
        score: str,
        position: int,
    ) -> pd.DataFrame:
        result = current.copy()
        for label in ("1d", "5d"):
            if label not in history:
                result[f"rank_{label}_ago"] = np.nan
                result[f"rank_change_{label}"] = np.nan
                result[f"score_change_{label}"] = np.nan
                continue
            previous = history[label][position].set_index(key)
            result[f"rank_{label}_ago"] = result[key].map(previous["rank"])
            result[f"rank_change_{label}"] = result[f"rank_{label}_ago"] - result["rank"]
            result[f"score_change_{label}"] = result[score] - result[key].map(previous[score])
        return result

    return (
        attach(sectors, "sector", "sector_score", 0),
        attach(themes, "theme", "theme_score", 1),
        {
            "reference_dates": {
                key: None if pd.isna(value) else pd.Timestamp(value)
                for key, value in references.items()
            },
            "periods_calculated": sorted(history),
            "failures": failures,
        },
    )


def classify_market_state(
    index_overview: pd.DataFrame,
    stock_snapshots: pd.DataFrame,
    risk_overview: pd.DataFrame,
) -> dict[str, Any]:
    index_map = index_overview.set_index("name")
    spx = index_map.loc["S&P 500"]
    equal_weight = index_map.loc["S&P 500 Equal Weight"] if "S&P 500 Equal Weight" in index_map.index else spx
    breadth20 = float(stock_snapshots["above_ma20"].mean())
    breadth50 = float(stock_snapshots["above_ma50"].mean())
    breadth200 = float(stock_snapshots["above_ma200"].mean())
    positive = float(stock_snapshots["return_1d"].gt(0).mean())
    concentration_gap = float(spx["return_20d"] - equal_weight["return_20d"])
    vix_rows = risk_overview.loc[risk_overview["name"].eq("VIX")]
    vix = float(vix_rows.iloc[0]["close"]) if not vix_rows.empty else np.nan
    if bool(spx["above_ma200"]) and breadth50 >= 0.55:
        state = "상승 확산" if concentration_gap < 0.03 else "상승 집중"
    elif bool(spx["above_ma200"]) and breadth50 >= 0.40:
        state = "상승 중 조정"
    elif not bool(spx["above_ma200"]) and breadth50 < 0.40:
        state = "하락 추세"
    else:
        state = "반등·전환 시도"
    risk_level = "높음" if (vix >= 25 or breadth50 < 0.35) else ("보통" if vix >= 18 else "낮음")
    return {
        "market_date": spx["date"],
        "state": state,
        "risk_level": risk_level,
        "sp500_return_1d": spx["return_1d"],
        "sp500_return_20d": spx["return_20d"],
        "sp500_ma200_gap": spx["ma200_gap"],
        "breadth_positive_1d": positive,
        "breadth_above_ma20": breadth20,
        "breadth_above_ma50": breadth50,
        "breadth_above_ma200": breadth200,
        "cap_vs_equal_weight_20d_gap": concentration_gap,
        "vix": vix,
        "interpretation": _market_state_interpretation(state, concentration_gap, vix),
    }


def _market_state_interpretation(state: str, concentration_gap: float, vix: float) -> str:
    notes = {
        "상승 확산": "지수 상승이 다수 종목으로 확산되어 추세의 질이 양호합니다.",
        "상승 집중": "지수는 강하지만 대형주 의존도가 높아 섹터·중소형주 확인이 필요합니다.",
        "상승 중 조정": "장기 상승 구조는 유지되지만 단기 시장 폭이 약해졌습니다.",
        "하락 추세": "지수와 시장 폭이 함께 약해 방어적 해석이 필요합니다.",
        "반등·전환 시도": "반등은 진행 중이지만 장기 추세 확인이 아직 부족합니다.",
    }[state]
    if concentration_gap >= 0.05:
        notes += " 시가총액 지수가 동일가중지수보다 크게 앞서 상승 집중도가 높습니다."
    if pd.notna(vix) and vix >= 25:
        notes += " VIX가 25 이상으로 기대 변동성도 높습니다."
    return notes


def _latest_pair(frame: pd.DataFrame, column: str, as_of: pd.Timestamp) -> tuple[float, float, pd.Timestamp]:
    if column not in frame.columns:
        return np.nan, np.nan, pd.NaT
    series = frame.loc[frame["date"].le(as_of), ["date", column]].dropna().sort_values("date")
    if series.empty:
        return np.nan, np.nan, pd.NaT
    latest = float(series.iloc[-1][column])
    previous = float(series.iloc[-2][column]) if len(series) >= 2 else np.nan
    return latest, previous, pd.Timestamp(series.iloc[-1]["date"])


def _latest_yoy(frame: pd.DataFrame, column: str, as_of: pd.Timestamp) -> tuple[float, float, pd.Timestamp]:
    if column not in frame.columns:
        return np.nan, np.nan, pd.NaT
    series = frame.loc[frame["date"].le(as_of), ["date", column]].dropna().sort_values("date")
    if len(series) < 13:
        return np.nan, np.nan, pd.NaT
    current = series.iloc[-1]
    previous = series.iloc[-2]
    year_ago = series.iloc[-13]
    previous_year_ago = series.iloc[-14] if len(series) >= 14 else year_ago
    yoy = float(current[column] / year_ago[column] - 1)
    previous_yoy = float(previous[column] / previous_year_ago[column] - 1)
    return yoy, previous_yoy, pd.Timestamp(current["date"])


def build_macro_dashboard(frame: pd.DataFrame, market_date: pd.Timestamp) -> pd.DataFrame:
    frame = frame.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    rows: list[dict[str, Any]] = []

    def add(label: str, series: str, unit: str, interpretation: str, *, yoy: bool = False, scale: float = 1.0) -> None:
        current, previous, date = (
            _latest_yoy(frame, series, market_date)
            if yoy
            else _latest_pair(frame, series, market_date)
        )
        rows.append(
            {
                "indicator": label,
                "series": series,
                "observation_date": date,
                "value": current * scale,
                "change": (current - previous) * scale if pd.notna(previous) else np.nan,
                "unit": unit,
                "interpretation": interpretation,
            }
        )

    add("미국 10년물 국채금리", "DGS10", "%", "장기 할인율과 경기 기대", scale=1)
    add("미국 2년물 국채금리", "DGS2", "%", "연준 정책금리 기대", scale=1)
    add("연방기금금리", "FEDFUNDS", "%", "현재 통화정책 수준", scale=1)
    add("CPI 전년비", "CPIAUCSL", "%", "소비자 물가 압력", yoy=True, scale=100)
    add("근원 CPI 전년비", "CPILFESL", "%", "기조적인 물가 압력", yoy=True, scale=100)
    add(
        "광범위 상품 생산자물가 전년비",
        "PPIACO",
        "%",
        "상품 생산자물가 압력; 최종수요 PPI와 다른 계열",
        yoy=True,
        scale=100,
    )
    add("PCE 물가 전년비", "PCEPI", "%", "연준이 중시하는 물가 방향", yoy=True, scale=100)
    add("실업률", "UNRATE", "%", "고용시장 여건", scale=1)
    add("비농업 고용", "PAYEMS", "천 명", "고용 총량; 변화는 전월 대비", scale=1)
    add("소매판매 전년비", "RSAFS", "%", "소비 경기", yoy=True, scale=100)
    add("산업생산 전년비", "INDPRO", "%", "제조업·생산 경기", yoy=True, scale=100)
    add("하이일드 스프레드", "BAMLH0A0HYM2", "%p", "신용시장 위험 선호", scale=1)
    result = pd.DataFrame(rows)
    ten = result.loc[result["series"].eq("DGS10"), "value"]
    two = result.loc[result["series"].eq("DGS2"), "value"]
    if not ten.empty and not two.empty:
        result = pd.concat(
            [
                result,
                pd.DataFrame(
                    [
                        {
                            "indicator": "10년-2년 금리차",
                            "series": "DGS10-DGS2",
                            "observation_date": market_date,
                            "value": float(ten.iloc[0] - two.iloc[0]),
                            "change": np.nan,
                            "unit": "%p",
                            "interpretation": "수익률곡선과 경기 기대",
                        }
                    ]
                ),
            ],
            ignore_index=True,
        )
    return result


def _unfold_ical(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _parse_ical_datetime(value: str) -> pd.Timestamp:
    value = value.strip()
    if re.fullmatch(r"\d{8}", value):
        return pd.to_datetime(value, format="%Y%m%d")
    if value.endswith("Z"):
        return pd.to_datetime(value, utc=True).tz_convert("America/New_York").tz_localize(None)
    return pd.to_datetime(value, format="%Y%m%dT%H%M%S", errors="coerce")


def collect_bls_calendar(settings: MarketRunSettings, config: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    url = str(config["macro"]["bls_calendar_url"])
    try:
        response = requests.get(url, headers={"User-Agent": "stock-strategy-market-report/0.1"}, timeout=30)
        response.raise_for_status()
        events: list[dict[str, Any]] = []
        current: dict[str, str] | None = None
        for line in _unfold_ical(response.text):
            if line == "BEGIN:VEVENT":
                current = {}
            elif line == "END:VEVENT" and current is not None:
                start_key = next((key for key in current if key.startswith("DTSTART")), None)
                if start_key:
                    events.append(
                        {
                            "event_time": _parse_ical_datetime(current[start_key]),
                            "event": current.get("SUMMARY", "BLS release").replace("\\,", ","),
                            "source": "U.S. Bureau of Labor Statistics",
                            "url": current.get("URL", url),
                        }
                    )
                current = None
            elif current is not None and ":" in line:
                key, value = line.split(":", 1)
                current[key] = value
        frame = pd.DataFrame(events)
        return frame, {"provider": "BLS iCalendar", "url": url, "rows": len(frame), "error": None}
    except Exception as error:  # noqa: BLE001
        fallback = config["macro"].get(f"bls_fallback_{settings.as_of.year}", [])
        frame = pd.DataFrame(
            [
                {
                    "event_time": pd.Timestamp(item[0]),
                    "event": str(item[1]),
                    "source": "U.S. Bureau of Labor Statistics (official-calendar fallback)",
                    "url": f"https://www.bls.gov/schedule/{settings.as_of.year}/home.htm",
                }
                for item in fallback
            ]
        )
        if frame.empty:
            frame = pd.DataFrame(columns=["event_time", "event", "source", "url"])
        return frame, {
            "provider": "BLS iCalendar",
            "url": url,
            "rows": len(frame),
            "error": str(error),
            "fallback_used": bool(len(frame)),
            "fallback_source": f"BLS official {settings.as_of.year} release calendar",
        }


def collect_bea_calendar(settings: MarketRunSettings, config: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    url = str(config["macro"]["bea_schedule_url"])
    try:
        response = requests.get(url, headers={"User-Agent": "stock-strategy-market-report/0.1"}, timeout=30)
        response.raise_for_status()
        tables = pd.read_html(StringIO(response.text))
        rows: list[dict[str, Any]] = []
        month_names = "January|February|March|April|May|June|July|August|September|October|November|December"
        for table in tables:
            for _, record in table.astype(str).iterrows():
                text = " | ".join(record.tolist())
                match = re.search(
                    rf"({month_names})\s+(\d{{1,2}}).*?(\d{{1,2}}:\d{{2}}\s*[AP]M).*?\|\s*(.+)$",
                    text,
                    flags=re.IGNORECASE,
                )
                if not match:
                    continue
                date_text = f"{match.group(1)} {match.group(2)} {settings.as_of.year} {match.group(3)}"
                event_time = pd.to_datetime(date_text, errors="coerce")
                event = re.sub(r"\s+", " ", match.group(4)).strip(" |")
                if pd.notna(event_time) and event:
                    rows.append(
                        {
                            "event_time": event_time,
                            "event": event,
                            "source": "U.S. Bureau of Economic Analysis",
                            "url": url,
                        }
                    )
        frame = pd.DataFrame(rows).drop_duplicates(["event_time", "event"]) if rows else pd.DataFrame(
            columns=["event_time", "event", "source", "url"]
        )
        return frame, {"provider": "BEA release schedule", "url": url, "rows": len(frame), "error": None}
    except Exception as error:  # noqa: BLE001
        return pd.DataFrame(columns=["event_time", "event", "source", "url"]), {
            "provider": "BEA release schedule",
            "url": url,
            "rows": 0,
            "error": str(error),
        }


def _event_latest_value(event: str, macro: pd.DataFrame) -> str:
    lower = event.lower()
    mappings = [
        (("consumer price", "cpi"), "CPI 전년비"),
        (("producer price", "ppi"), "광범위 상품 생산자물가 전년비"),
        (("employment situation", "unemployment"), "실업률"),
        (("personal income", "pce"), "PCE 물가 전년비"),
        (("retail",), "소매판매 전년비"),
        (("industrial production",), "산업생산 전년비"),
    ]
    for needles, indicator in mappings:
        if any(needle in lower for needle in needles):
            rows = macro.loc[macro["indicator"].eq(indicator)]
            if not rows.empty:
                row = rows.iloc[0]
                return f"{row['value']:.2f}{row['unit']} (관측 {pd.to_datetime(row['observation_date']):%Y-%m-%d})"
    return "공식 일정 확인; 정형 실제값 매핑 없음"


def build_economic_events(
    calendars: list[pd.DataFrame],
    macro: pd.DataFrame,
    market_date: pd.Timestamp,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    available = [frame for frame in calendars if not frame.empty]
    if not available:
        empty = pd.DataFrame(columns=["event_time", "event", "source", "url", "latest_value", "consensus", "interpretation"])
        return empty, empty.copy()
    events = pd.concat(available, ignore_index=True)
    events["event_time"] = pd.to_datetime(events["event_time"])
    events["latest_value"] = events["event"].map(lambda value: _event_latest_value(str(value), macro))
    events["consensus"] = "미연결"
    events["interpretation"] = events["event"].map(_event_interpretation)
    today = events.loc[events["event_time"].dt.date == market_date.date()].sort_values("event_time")
    upcoming = events.loc[
        events["event_time"].dt.date.between(
            (market_date + pd.Timedelta(days=1)).date(),
            (market_date + pd.Timedelta(days=10)).date(),
        )
    ].sort_values("event_time")
    return today.reset_index(drop=True), upcoming.reset_index(drop=True)


def _event_interpretation(event: str) -> str:
    lower = event.lower()
    if "consumer price" in lower or "producer price" in lower or "pce" in lower:
        return "예상 상회 시 금리·달러 상승과 성장주 부담, 하회 시 반대 가능성"
    if "employment" in lower or "job" in lower:
        return "고용 강도에 따라 경기 기대와 연준 금리 경로가 함께 변할 수 있음"
    if "gdp" in lower:
        return "성장 강도와 물가 조합에 따라 경기민감주·금리 반응을 함께 확인"
    if "retail" in lower or "personal income" in lower:
        return "소비 여력과 경기민감 업종에 미치는 영향 확인"
    return "발표 후 국채금리·달러·주가지수의 동행 반응을 확인"


def _parse_rss(content: bytes, feed_name: str, query: str = "") -> list[dict[str, Any]]:
    root = ET.fromstring(content)
    rows: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        published_text = item.findtext("pubDate") or item.findtext("date") or ""
        source_element = item.find("source")
        source = (
            source_element.text.strip()
            if source_element is not None and source_element.text
            else feed_name
        )
        try:
            published = pd.Timestamp(parsedate_to_datetime(published_text)).tz_convert("UTC").tz_localize(None)
        except Exception:  # noqa: BLE001
            published = pd.NaT
        if title and link:
            rows.append(
                {
                    "published_at": published,
                    "title": title,
                    "source": source,
                    "url": link,
                    "feed": feed_name,
                    "query": query,
                }
            )
    return rows


def _news_topics(title: str) -> tuple[str, str, str]:
    lower = title.lower()
    mapping = [
        (("cpi", "inflation", "ppi", "pce", "prices"), "물가·금리", "금융·성장주", "물가 서프라이즈가 금리 경로를 바꾸는지 확인"),
        (("fomc", "monetary policy", "fed chair", "powell", "rate cut", "interest rate", "fed minutes"), "연준·금리", "기술·금융·부동산", "연준 경로 변화와 2년물 금리 반응 확인"),
        (("jobs", "payroll", "unemployment", "labor"), "고용", "경기민감·소비", "고용 강도와 경기·금리 기대의 조합 확인"),
        (("oil", "crude", "opec"), "원유", "에너지·운송·소비", "유가 방향과 에너지 이익·물가 부담을 함께 확인"),
        (("semiconductor", "chip", "nvidia", "ai "), "AI·반도체", "정보기술·데이터센터", "실적·수요 근거와 밸류에이션 과열 여부 확인"),
        (("cyber", "hack", "security"), "사이버보안", "정보기술", "수요 증가와 개별 기업의 실적 연결 여부 확인"),
        (("space", "satellite", "rocket", "launch"), "우주·위성", "산업재·통신", "수주·발사 일정과 테마 가격 확산 여부 확인"),
        (("nuclear", "uranium", "power grid", "electricity"), "원전·전력망", "유틸리티·산업재", "전력 수요·정책·원자재 가격의 지속성 확인"),
        (("war", "missile", "defense", "geopolitical"), "지정학·방산", "방산·에너지", "사건성 급등과 실제 수주·원가 영향을 구분"),
        (("earnings", "revenue", "guidance", "profit"), "기업실적", "해당 기업·동종업계", "실적과 가이던스가 섹터 전반으로 확산되는지 확인"),
    ]
    for keywords, topic, affected, interpretation in mapping:
        if any(keyword in lower for keyword in keywords):
            return topic, affected, interpretation
    return "시장 일반", "미국 주식시장", "지수·금리·시장 폭의 실제 반응과 함께 해석"


def _news_tone(title: str) -> str:
    lower = title.lower()
    positive = ("rally", "surge", "gain", "beat", "record", "cut rates", "cooling", "eases")
    negative = ("fall", "drop", "slump", "miss", "fear", "hot inflation", "tariff", "warning", "risk")
    positive_score = sum(word in lower for word in positive)
    negative_score = sum(word in lower for word in negative)
    return "긍정 가능" if positive_score > negative_score else ("부정 가능" if negative_score > positive_score else "혼합·중립")


def collect_market_news(
    settings: MarketRunSettings,
    market_date: pd.Timestamp,
    config: dict[str, Any],
) -> tuple[pd.DataFrame, dict[str, Any]]:
    NEWS_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    cache_path = NEWS_CACHE_ROOT / f"news_{settings.as_of:%Y%m%d}_v2.json"
    if cache_path.exists() and not settings.refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        frame = pd.DataFrame(cached)
        if not frame.empty:
            frame["published_at"] = pd.to_datetime(frame["published_at"])
        return frame, {"cache_hit": True, "rows": len(frame), "failures": []}

    rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    feeds: list[tuple[str, str, str]] = []
    for query in config["news"]["google_rss_queries"]:
        url = (
            "https://news.google.com/rss/search?q="
            + quote_plus(str(query))
            + "&hl=en-US&gl=US&ceid=US:en"
        )
        feeds.append(("Google News RSS", url, str(query)))
    feeds.append(("Federal Reserve", str(config["macro"]["fed_press_feed_url"]), "Federal Reserve official"))
    for feed_name, url, query in feeds:
        try:
            response = requests.get(
                url,
                headers={"User-Agent": "stock-strategy-market-report/0.1"},
                timeout=30,
            )
            response.raise_for_status()
            rows.extend(_parse_rss(response.content, feed_name, query))
        except Exception as error:  # noqa: BLE001
            failures.append({"feed": feed_name, "url": url, "error": str(error)})
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(
            columns=["published_at", "title", "source", "url", "topic", "affected_assets", "tone", "interpretation"]
        ), {"cache_hit": False, "rows": 0, "failures": failures}
    frame = frame.dropna(subset=["published_at"]).copy()
    start = market_date - pd.Timedelta(days=int(config["news"]["lookback_days"]))
    end = settings.as_of + pd.Timedelta(days=1)
    frame = frame.loc[frame["published_at"].between(start, end)].copy()
    frame["normalized_title"] = (
        frame["title"].str.lower().str.replace(r"\s+-\s+[^-]+$", "", regex=True).str.replace(r"\W+", " ", regex=True)
    )
    frame = frame.sort_values("published_at", ascending=False).drop_duplicates("normalized_title")
    details = frame["title"].map(_news_topics)
    frame["topic"] = [item[0] for item in details]
    frame["affected_assets"] = [item[1] for item in details]
    frame["interpretation"] = [item[2] for item in details]
    frame["tone"] = frame["title"].map(_news_tone)
    trusted_pattern = r"Reuters|Bloomberg|CNBC|Associated Press|AP News|Wall Street Journal|Financial Times|MarketWatch|Barron's"
    official_relevant = frame["feed"].eq("Federal Reserve") & frame["topic"].eq("연준·금리")
    frame["relevance_score"] = (
        official_relevant.astype(int) * 4
        + frame["source"].str.contains(trusted_pattern, case=False, regex=True).astype(int) * 3
        + frame["topic"].ne("시장 일반").astype(int) * 2
        + frame["published_at"].rank(pct=True)
    )
    frame = frame.sort_values(["relevance_score", "published_at"], ascending=False).head(
        int(config["news"]["max_items"])
    )
    keep = [
        "published_at",
        "title",
        "source",
        "url",
        "topic",
        "affected_assets",
        "tone",
        "interpretation",
        "feed",
        "relevance_score",
    ]
    frame = frame[keep].reset_index(drop=True)
    cache_path.write_text(frame.to_json(orient="records", date_format="iso", force_ascii=False), encoding="utf-8")
    return frame, {"cache_hit": False, "rows": len(frame), "failures": failures}


def _pct(value: Any) -> str:
    return "N/A" if value is None or pd.isna(value) else f"{float(value):.2%}"


def _num(value: Any, digits: int = 2) -> str:
    return "N/A" if value is None or pd.isna(value) else f"{float(value):.{digits}f}"


def _align_index_closes(
    prices: pd.DataFrame,
    tickers: list[str],
    benchmark_ticker: str,
    periods: int = 60,
) -> pd.DataFrame:
    """Align index closes to one benchmark trading calendar without filling gaps."""

    selected = prices.loc[
        prices["ticker"].isin(tickers),
        ["date", "ticker", "close"],
    ].copy()
    selected["date"] = pd.to_datetime(selected["date"])
    pivot = (
        selected.sort_values("date")
        .drop_duplicates(["date", "ticker"], keep="last")
        .pivot(index="date", columns="ticker", values="close")
        .sort_index()
        .reindex(columns=tickers)
    )
    if benchmark_ticker not in pivot or pivot[benchmark_ticker].dropna().empty:
        return pd.DataFrame(columns=tickers, dtype=float)

    benchmark_dates = pivot[benchmark_ticker].dropna().tail(periods).index
    aligned = pivot.reindex(benchmark_dates)
    complete_rows = aligned.notna().all(axis=1).to_numpy()
    if complete_rows.any():
        aligned = aligned.iloc[int(np.flatnonzero(complete_rows)[0]) :]
    return aligned


def plot_market_dashboard(
    prices: pd.DataFrame,
    index_overview: pd.DataFrame,
    sectors: pd.DataFrame,
    themes: pd.DataFrame,
    output: Path,
    config: dict[str, Any],
) -> None:
    installed_fonts = {font.name for font in font_manager.fontManager.ttflist}
    for preferred_font in ("Malgun Gothic", "Noto Sans CJK KR", "NanumGothic"):
        if preferred_font in installed_fonts:
            plt.rcParams["font.family"] = preferred_font
            break
    plt.rcParams["axes.unicode_minus"] = False
    fig, axes = plt.subplots(2, 2, figsize=(15, 10), layout="constrained")
    index_symbols = {str(value).upper(): key for key, value in config["indices"].items()}
    benchmark_ticker = str(config["indices"]["S&P 500"]).upper()
    aligned_closes = _align_index_closes(
        prices,
        list(index_symbols),
        benchmark_ticker,
        periods=60,
    )
    for ticker, name in index_symbols.items():
        if aligned_closes.empty or aligned_closes[ticker].dropna().empty:
            continue
        cumulative_return = (aligned_closes[ticker] / aligned_closes[ticker].iloc[0] - 1) * 100
        axes[0, 0].plot(aligned_closes.index, cumulative_return, label=name, linewidth=1.7)
    axes[0, 0].axhline(0, color="#64748b", linewidth=0.8)
    axes[0, 0].set_title("주요 지수 누적 등락률 · S&P 500 공통 60거래일", loc="left")
    axes[0, 0].set_ylabel("시작일 대비 등락률 (%)")
    axes[0, 0].legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.16),
        ncol=3,
        fontsize=7,
        frameon=False,
    )
    axes[0, 0].grid(alpha=0.25)

    sector_plot = sectors.sort_values("relative_20d")
    colors = ["tab:blue" if value >= 0 else "tab:red" for value in sector_plot["relative_20d"]]
    axes[0, 1].barh(sector_plot["sector"], sector_plot["relative_20d"] * 100, color=colors)
    axes[0, 1].axvline(0, color="black", linewidth=0.8)
    axes[0, 1].set_title("섹터 상대성과 · 최근 1개월", loc="left")
    axes[0, 1].set_xlabel("S&P 500 대비 초과·부진 폭 (%p)")
    axes[0, 1].grid(axis="x", alpha=0.25)

    theme_plot = themes.sort_values("relative_20d")
    colors = ["tab:green" if value >= 0 else "tab:orange" for value in theme_plot["relative_20d"]]
    axes[1, 0].barh(theme_plot["theme"], theme_plot["relative_20d"] * 100, color=colors)
    axes[1, 0].axvline(0, color="black", linewidth=0.8)
    axes[1, 0].set_title("테마 상대성과 · 최근 1개월", loc="left")
    axes[1, 0].set_xlabel("S&P 500 대비 초과·부진 폭 (%p)")
    axes[1, 0].grid(axis="x", alpha=0.25)

    breadth_plot = sectors.sort_values("above_ma50_breadth")
    axes[1, 1].barh(
        breadth_plot["sector"],
        breadth_plot["above_ma50_breadth"] * 100,
        color="#4f83df",
    )
    axes[1, 1].axvline(50, color="#334155", linestyle="--", linewidth=1.0)
    axes[1, 1].annotate(
        "과반 참여 기준 50%",
        xy=(50, 1),
        xycoords=("data", "axes fraction"),
        xytext=(5, -8),
        textcoords="offset points",
        fontsize=8,
        color="#334155",
        ha="left",
        va="top",
    )
    axes[1, 1].set_xlim(0, 100)
    sp500_rows = index_overview.loc[index_overview["name"].eq("S&P 500")]
    breadth_title = "섹터별 상승 참여도 · 50일 이동평균선 기준"
    if not sp500_rows.empty:
        breadth_end = pd.Timestamp(sp500_rows.iloc[0]["date"])
        breadth_history = (
            prices.loc[
                prices["ticker"].eq(benchmark_ticker)
                & pd.to_datetime(prices["date"]).le(breadth_end),
                ["date", "close"],
            ]
            .sort_values("date")
            .dropna(subset=["close"])
            .tail(50)
        )
        if len(breadth_history) == 50:
            breadth_start = pd.Timestamp(breadth_history["date"].iloc[0])
            breadth_eligible = int(
                breadth_plot.get("ma50_constituents", breadth_plot["constituents"]).sum()
            )
            breadth_total = int(breadth_plot["constituents"].sum())
            breadth_title = (
                f"섹터별 상승 참여도 · {breadth_end:%Y-%m-%d} 기준\n"
                f"50거래일 평균 {breadth_start:%Y-%m-%d}~{breadth_end:%Y-%m-%d}"
                f" · 데이터 {breadth_eligible}/{breadth_total}종목"
            )
    axes[1, 1].set_title(breadth_title, loc="left")
    axes[1, 1].set_xlabel("50일선 위에 있는 구성 종목 비율 (%)")
    axes[1, 1].grid(axis="x", alpha=0.25)
    fig.suptitle("미국 시장 구조 대시보드")
    fig.savefig(output / "market_dashboard.png", dpi=160, bbox_inches="tight")
    plt.close(fig)


def write_market_report(
    settings: MarketRunSettings,
    market_state: dict[str, Any],
    indices: pd.DataFrame,
    risks: pd.DataFrame,
    sectors: pd.DataFrame,
    themes: pd.DataFrame,
    leaders: pd.DataFrame,
    macro: pd.DataFrame,
    today_events: pd.DataFrame,
    upcoming_events: pd.DataFrame,
    news: pd.DataFrame,
    quality: dict[str, Any],
) -> str:
    top_sector = sectors.iloc[0]
    top_theme = themes.iloc[0]
    weakest_sector = sectors.iloc[-1]
    index_lines = "\n".join(
        f"| {row['name']} ({row.ticker}) | {_pct(row.return_1d)} | {_pct(row.return_5d)} | "
        f"{_pct(row.return_20d)} | {_pct(row.ma200_gap)} | {row.chart_phase} |"
        for _, row in indices.iterrows()
    )
    risk_lines = "\n".join(
        f"| {row['name']} ({row.ticker}) | {_num(row.close)} | {_pct(row.return_1d)} | "
        f"{_pct(row.return_20d)} | {row.chart_phase} |"
        for _, row in risks.iterrows()
    )
    sector_lines = "\n".join(
        f"| {int(row['rank'])} | {row.sector_display} | {_num(row.sector_score, 1)} | {_pct(row.return_1d)} | "
        f"{_pct(row.relative_20d)} | {_pct(row.relative_60d)} | {_pct(row.above_ma50_breadth)} | "
        f"{row.leadership_quality} | {row.leader} | {row.leader_phase} |"
        for _, row in sectors.iterrows()
    )
    theme_lines = "\n".join(
        f"| {int(row['rank'])} | {row.theme} ({row.proxy}) | {_num(row.theme_score, 1)} | {_pct(row.return_1d)} | "
        f"{_pct(row.relative_20d)} | {_pct(row.relative_60d)} | {_pct(row.above_ma50_breadth)} | "
        f"{row.leadership_quality} | {row.leader} | {row.leader_phase} |"
        for _, row in themes.iterrows()
    )
    leader_lines = "\n".join(
        f"| {'섹터' if row.scope == 'sector' else '테마'} | {row.group_display} | {row.company_ticker} | "
        f"{_num(row.leader_score, 2)} | {_pct(row.return_20d)} | {_pct(row.return_60d)} | "
        f"{_num(row.volume_ratio_20, 2)}배 | {row.chart_phase} | {row.risk_note} |"
        for _, row in leaders.sort_values(["scope", "leader_score"], ascending=[True, False]).iterrows()
    )
    macro_lines = "\n".join(
        f"| {row.indicator} | {_num(row.value)}{row.unit} | {_num(row.change)}{row.unit} | "
        f"{pd.to_datetime(row.observation_date):%Y-%m-%d} | {row.interpretation} |"
        for _, row in macro.iterrows()
        if pd.notna(row.value)
    )
    if today_events.empty:
        today_event_lines = "| 해당 미국 거래일의 BLS·BEA 주요 정기 발표 없음 | - | - | - | - |"
    else:
        today_event_lines = "\n".join(
            f"| {pd.to_datetime(row.event_time):%H:%M} | [{row.event}]({row.url}) | {row.latest_value} | "
            f"{row.consensus} | {row.interpretation} |"
            for _, row in today_events.iterrows()
        )
    if upcoming_events.empty:
        upcoming_lines = "| 향후 10일 공식 일정 수집 결과 없음 | - | - |"
    else:
        upcoming_lines = "\n".join(
            f"| {pd.to_datetime(row.event_time):%Y-%m-%d %H:%M} | [{row.event}]({row.url}) | {row.source} |"
            for _, row in upcoming_events.head(12).iterrows()
        )
    if news.empty:
        news_lines = "| 실제 뉴스 피드 수집 실패 | - | - | - | - |"
    else:
        news_lines = "\n".join(
            f"| {pd.to_datetime(row.published_at):%m-%d %H:%M} | [{row.title}]({row.url}) | {row.source} | "
            f"{row.topic} | {row.affected_assets} | {row.tone}; {row.interpretation} |"
            for _, row in news.iterrows()
        )
    event_summary = (
        "정기 발표 없음"
        if today_events.empty
        else ", ".join(today_events["event"].astype(str).head(2))
    )
    top_sector_name = top_sector.sector_display
    weakest_sector_name = weakest_sector.sector_display
    report = f"""# 미국 시장 일일 리포트

생성 기준일: **{settings.as_of:%Y-%m-%d}**  
최신 미국 거래일: **{pd.to_datetime(market_state['market_date']):%Y-%m-%d}**  
목적: **전체 시장 → 섹터·테마 → 대장주 → 차트 단계 → 거시 발표·뉴스 순서로 시장을 읽는 자료**

> 이 문서는 포트폴리오 리포트가 아니며 종목 비중이나 자동주문을 제공하지 않는다. 섹터·대장주 정보는 사용자가 직접 판단하기 위한 시장 관찰 결과다.

## 1. 오늘의 결론

- 전체 시장: **{market_state['state']}**, 위험 수준 **{market_state['risk_level']}**. {market_state['interpretation']}
- 시장 폭: 상승 종목 {_pct(market_state['breadth_positive_1d'])}, 50일선 상회 {_pct(market_state['breadth_above_ma50'])}, 200일선 상회 {_pct(market_state['breadth_above_ma200'])}.
- 가장 강한 섹터: **{top_sector_name}**, 20일 상대수익률 {_pct(top_sector.relative_20d)}, 확산도 {top_sector.leadership_quality}, 대장주 **{top_sector.leader}**.
- 가장 강한 테마: **{top_theme.theme}**, 20일 상대수익률 {_pct(top_theme.relative_20d)}, 대장주 **{top_theme.leader}**, 차트 단계 **{top_theme.leader_phase}**.
- 가장 약한 섹터: **{weakest_sector_name}**, 20일 상대수익률 {_pct(weakest_sector.relative_20d)}.
- 당일 공식 경제일정: **{event_summary}**. 뉴스 해석은 제목·공식 발표와 시장 가격을 연결한 규칙 기반 1차 의견이며 원문 확인이 필요하다.

![시장 구조 대시보드](market_dashboard.png)

## 2. 전체 시장 상태

| 지수 | 1일 | 5일 | 20일 | 200일선 괴리 | 차트 단계 |
|---|---:|---:|---:|---:|---|
{index_lines}

현재 S&P 500과 동일가중지수의 20일 수익률 차이는 **{_pct(market_state['cap_vs_equal_weight_20d_gap'])}**다. 양수 폭이 클수록 대형주 집중 상승으로 해석한다.

### 위험·교차자산

| 자산 | 종가 | 1일 | 20일 | 상태 |
|---|---:|---:|---:|---|
{risk_lines}

VIX는 향후 약 30일 S&P 500 기대 변동성을 반영한다. 원유·달러·채권은 주식시장 원인을 단정하는 값이 아니라 주식 움직임과 일치하는지 확인하는 교차검증 자료다.

## 3. 섹터 리더십

섹터 점수는 S&P 500 대비 5·20·60일 상대강도와 섹터 구성종목의 50일선 상회 비율을 결합한다. ETF는 섹터 비교 프록시일 뿐 매수 제안이 아니다.

| 순위 | 섹터 | 점수 | 1일 | 20일 상대 | 60일 상대 | 50일선 상회 | 상승의 질 | 대장주 | 단계 |
|---:|---|---:|---:|---:|---:|---:|---|---|---|
{sector_lines}

## 4. 테마 리더십

우주·위성 등 테마는 공식 GICS 섹터가 아니므로 대표 ETF를 비교 프록시로, 유동성 필터를 통과한 개별 종목을 대장주 후보로 사용한다.

| 순위 | 테마(프록시) | 점수 | 1일 | 20일 상대 | 60일 상대 | 50일선 상회 | 상승의 질 | 대장주 | 단계 |
|---:|---|---:|---:|---:|---:|---:|---|---|---|
{theme_lines}

## 5. 섹터·테마 대장주와 차트 위치

대장주 점수는 20·60일 상대강도, 최근 거래량, 52주 범위 내 위치를 결합한다. `과열 상승`은 강한 종목이라는 뜻과 동시에 추격 위험이 큰 구간이라는 뜻이다.

| 구분 | 그룹 | 회사명(티커) | 대장 점수 | 20일 | 60일 | 거래량 | 차트 단계 | 확인할 위험 |
|---|---|---|---:|---:|---:|---:|---|---|
{leader_lines}

## 6. 금리·물가·경기 지표

| 지표 | 최신값 | 직전 변화 | 관측일 | 의미 |
|---|---:|---:|---|---|
{macro_lines}

월간 지표는 최신 발표 대상 월 기준이며 일별 시장일과 시차가 있다. 컨센서스 예상치는 공식 기관이 제공하지 않으므로 별도 공급자를 연결하기 전까지 임의 생성하지 않는다.

## 7. 해당 거래일의 공식 경제 발표

| 시간(미 동부) | 발표 | 최신 정형값 | 컨센서스 | 해석 기준 |
|---|---|---|---|---|
{today_event_lines}

### 향후 10일 주요 공식 일정

| 미국 동부시간 | 발표 | 출처 |
|---|---|---|
{upcoming_lines}

## 8. 주요 뉴스와 해석

| 시각(UTC) | 제목·원문 | 출처 | 주제 | 영향 후보 | 1차 해석 |
|---|---|---|---|---|---|
{news_lines}

뉴스는 실제 RSS 원문 제목과 링크를 저장한다. 현재 LLM API는 연결하지 않았으며, 해석은 키워드와 자산 민감도를 이용한 규칙 기반 의견이다. 사실과 인과관계를 확정하지 않으며 원문·공식 발표·가격 반응을 함께 확인해야 한다.

## 9. 다음 거래일 확인 항목

- 시장: S&P 500 상승이 동일가중지수와 50일선 상회 종목 비율로 확산되는지 확인
- 섹터: **{top_sector_name}**의 상대강도와 구성종목 확산도가 유지되는지 확인
- 테마: **{top_theme.theme}** 대장주 **{top_theme.leader}**가 현재 `{top_theme.leader_phase}` 단계를 유지하는지 확인
- 위험: VIX {_num(market_state['vix'])}, 10년물 금리, 달러가 주식 상승과 반대 방향으로 급변하는지 확인
- 일정: 위 공식 발표 전후에는 결과뿐 아니라 국채금리·달러·성장주 반응을 함께 확인

## 10. 데이터 품질과 한계

| 항목 | 상태 |
|---|---|
| 가격 심볼 | {quality['prices']['successful']}/{quality['prices']['requested']} 성공 |
| S&P 500 종목 스냅샷 | {quality['stock_snapshot_rows']}개 |
| 섹터 | {quality['sector_rows']}개 |
| 테마 | {quality['theme_rows']}개 |
| 뉴스 | {quality['news']['rows']}개; 실패 피드 {len(quality['news']['failures'])}개 |
| 공식 일정 | BLS {quality['calendars']['bls']['rows']}개, BEA {quality['calendars']['bea']['rows']}개 |
| 런타임 검증 | **{'통과' if quality['validation']['passed'] else '실패'}** |

- 가격은 장 마감 후 일봉이며 실시간 스트리밍이 아니다.
- 현재 S&P 500 스냅샷으로 계산한 시장 폭은 현재 시장 진단에는 사용할 수 있지만 과거 구성종목 백테스트에는 생존편향이 생긴다.
- 테마 구성은 고정된 연구 바스켓이며 기업 사업구조 변화에 따라 정기 검토가 필요하다.
- 뉴스의 규칙 기반 해석은 1차 의견이다. 인증된 뉴스·컨센서스·LLM 제공자가 연결되면 근거와 신뢰도 체계를 강화할 수 있다.
- 자동매매와 사용자 포트폴리오는 이 리포트의 범위가 아니다.

## 11. 원본 파일

- `market_overview.csv`: 주요 지수·위험자산
- `sector_leadership.csv`: 11개 섹터 순위와 시장 폭
- `theme_leadership.csv`: 테마 순위
- `market_leaders.csv`: 섹터·테마 대장주와 차트 단계
- `macro_dashboard.csv`: 금리·물가·경기 지표
- `economic_events_today.csv`, `economic_events_upcoming.csv`: 공식 발표 일정
- `market_news.csv`: 실제 뉴스 제목·출처·링크와 1차 해석
- `market_data_quality.json`: 수집·검증 상태
"""
    return report


def run_market_report(settings: MarketRunSettings) -> dict[str, Any]:
    config = load_config(settings.config_path)
    archive_audit = archive_legacy_reports(RESULTS_ROOT)
    settings.output_dir.mkdir(parents=True, exist_ok=True)

    LOGGER.info("1/10 Loading current S&P 500 membership")
    universe = fetch_sp500_snapshot(settings.as_of, refresh=settings.refresh)
    symbols: set[str] = set(universe["ticker"].astype(str))
    for key in ("indices", "risk_assets", "sector_proxies"):
        symbols.update(str(value) for value in config[key].values())
    for definition in config["themes"].values():
        symbols.add(str(definition["proxy"]))
        symbols.update(str(value) for value in definition["members"])
    symbols.add(str(config.get("portfolio_report", {}).get("benchmark", "IVV")))

    LOGGER.info("2/10 Collecting post-close market prices for %d symbols", len(symbols))
    prices, price_audit = collect_context_prices(sorted(symbols), settings, config)
    market_date = prices.loc[prices["ticker"].eq(str(config["indices"]["S&P 500"])), "date"].max()
    if pd.isna(market_date):
        raise RuntimeError("S&P 500 market date is unavailable.")

    LOGGER.info("3/10 Calculating index, breadth, and market regime")
    stocks = build_stock_snapshots(prices, universe)
    indices, risks = build_index_overview(prices, config)
    if "S&P 500" not in set(indices["name"]):
        raise RuntimeError("S&P 500 overview row is missing.")
    benchmark = indices.loc[indices["name"].eq("S&P 500")].iloc[0]
    market_state = classify_market_state(indices, stocks, risks)

    LOGGER.info("4/10 Ranking 11 sectors and configured themes")
    sectors, sector_leaders = build_sector_leadership(stocks, benchmark)
    themes, theme_leaders = build_theme_leadership(prices, universe, benchmark, config)
    leaders = pd.concat([sector_leaders, theme_leaders], ignore_index=True)
    breadth_audit = audit_ma50_breadth(
        prices,
        universe,
        market_date,
        sectors,
        str(config["indices"]["S&P 500"]),
    )

    LOGGER.info("5/10 Calculating prior-session and five-session rotation changes")
    sectors, themes, rotation_audit = enrich_rotation_history(
        prices,
        universe,
        config,
        market_date,
        sectors,
        themes,
    )

    LOGGER.info("6/10 Collecting FRED macro dashboard")
    fred, fred_audit = collect_fred_market_macro(settings, config)
    macro = build_macro_dashboard(fred, market_date)

    LOGGER.info("7/10 Collecting official BLS/BEA release calendars")
    bls, bls_audit = collect_bls_calendar(settings, config)
    bea, bea_audit = collect_bea_calendar(settings, config)
    today_events, upcoming_events = build_economic_events([bls, bea], macro, market_date)

    LOGGER.info("8/10 Collecting sourced market news")
    news, news_audit = collect_market_news(settings, market_date, config)
    macro_axes = build_macro_axes(macro, risks, market_state)
    news_clusters = build_news_clusters(news, themes, indices)
    transmissions = build_transmission_signals(macro, risks, sectors, indices, market_state)

    validation = {
        "price_duplicates": int(prices.duplicated(["ticker", "date"]).sum()),
        "stock_snapshot_rows": len(stocks),
        "index_rows": len(indices),
        "sector_rows": len(sectors),
        "theme_rows": len(themes),
        "news_rows": len(news),
        "macro_axis_rows": len(macro_axes),
        "news_cluster_rows": len(news_clusters),
        "transmission_rows": len(transmissions),
        "missing_sector_leaders": int(sectors["leader"].isna().sum()),
        "ma50_breadth_passed": breadth_audit["passed"],
    }
    violations = [
        validation["price_duplicates"] > 0,
        validation["stock_snapshot_rows"] < 490,
        validation["index_rows"] < 4,
        validation["sector_rows"] != 11,
        validation["theme_rows"] < 6,
        validation["news_rows"] < 1,
        validation["macro_axis_rows"] != 4,
        validation["news_cluster_rows"] < 1,
        validation["transmission_rows"] < 3,
        validation["missing_sector_leaders"] > 0,
        not validation["ma50_breadth_passed"],
    ]
    validation["passed"] = not any(violations)
    quality = {
        "as_of": settings.as_of,
        "market_date": market_date,
        "prices": price_audit,
        "fred": fred_audit,
        "calendars": {"bls": bls_audit, "bea": bea_audit},
        "news": news_audit,
        "rotation_history": rotation_audit,
        "ma50_breadth": breadth_audit,
        "stock_snapshot_rows": len(stocks),
        "sector_rows": len(sectors),
        "theme_rows": len(themes),
        "archive": archive_audit,
        "validation": validation,
        "limitations": [
            "post-close daily data, not real-time streaming",
            "current-constituent breadth is unsuitable for unbiased historical backtests",
            "theme baskets require periodic business-exposure review",
            "news interpretation is rules-based because no authenticated LLM provider is configured",
            "economic consensus estimates are not connected",
        ],
    }
    if not validation["passed"]:
        raise RuntimeError(f"Market report validation failed: {validation}")

    LOGGER.info("9/10 Writing market-only source artifacts")
    overview = pd.concat([indices, risks], ignore_index=True)
    atomic_write_csv(overview, settings.output_dir / "market_overview.csv")
    atomic_write_csv(sectors, settings.output_dir / "sector_leadership.csv")
    atomic_write_csv(themes, settings.output_dir / "theme_leadership.csv")
    atomic_write_csv(leaders, settings.output_dir / "market_leaders.csv")
    atomic_write_csv(macro, settings.output_dir / "macro_dashboard.csv")
    atomic_write_csv(today_events, settings.output_dir / "economic_events_today.csv")
    atomic_write_csv(upcoming_events, settings.output_dir / "economic_events_upcoming.csv")
    atomic_write_csv(news, settings.output_dir / "market_news.csv")
    atomic_write_csv(macro_axes, settings.output_dir / "macro_axes.csv")
    atomic_write_csv(news_clusters, settings.output_dir / "news_clusters.csv")
    atomic_write_csv(transmissions, settings.output_dir / "transmission_signals.csv")
    write_json(market_state, settings.output_dir / "market_state.json")
    write_json(quality, settings.output_dir / "market_data_quality.json")
    plot_market_dashboard(prices, indices, sectors, themes, settings.output_dir, config)

    LOGGER.info("10/10 Rendering the human-facing Markdown and HTML reports")
    report = write_market_report(
        settings,
        market_state,
        indices,
        risks,
        sectors,
        themes,
        leaders,
        macro,
        today_events,
        upcoming_events,
        news,
        quality,
    )
    _write_text_atomic(report, settings.output_dir / "MARKET_REPORT.md")
    _write_text_atomic(report, RESULTS_ROOT / "LATEST_MARKET_REPORT.md")
    html_report = render_market_html(
        as_of=settings.as_of,
        market_state=market_state,
        indices=indices,
        risks=risks,
        sectors=sectors,
        themes=themes,
        leaders=leaders,
        macro=macro,
        macro_axes=macro_axes,
        today_events=today_events,
        upcoming_events=upcoming_events,
        news_clusters=news_clusters,
        transmissions=transmissions,
        quality=quality,
    )
    _write_text_atomic(html_report, settings.output_dir / "MARKET_REPORT.html")
    _write_text_atomic(html_report, RESULTS_ROOT / "LATEST_MARKET_REPORT.html")
    shutil.copyfile(
        settings.output_dir / "market_dashboard.png",
        RESULTS_ROOT / "market_dashboard.png",
    )
    manifest = {
        "generated_at": pd.Timestamp.now(tz="Asia/Seoul"),
        "as_of": settings.as_of,
        "market_date": market_date,
        "purpose": "market intelligence only; no portfolio or orders",
        "files": sorted(path.name for path in settings.output_dir.iterdir() if path.is_file()),
    }
    write_json(manifest, settings.output_dir / "market_report_manifest.json")
    return {
        "output_dir": settings.output_dir,
        "report": settings.output_dir / "MARKET_REPORT.md",
        "html_report": settings.output_dir / "MARKET_REPORT.html",
        "latest_report": RESULTS_ROOT / "LATEST_MARKET_REPORT.md",
        "latest_html_report": RESULTS_ROOT / "LATEST_MARKET_REPORT.html",
        "market_state": market_state,
        "top_sector": sectors.iloc[0][["sector", "sector_display", "sector_score", "leader"]].to_dict(),
        "top_theme": themes.iloc[0][["theme", "theme_score", "leader"]].to_dict(),
        "news_items": len(news),
        "validation": validation,
    }


def rerender_market_html(output_dir: Path, as_of: pd.Timestamp) -> dict[str, Any]:
    """Render HTML only from previously validated artifacts; never access the network."""

    required = [
        "market_state.json",
        "market_overview.csv",
        "sector_leadership.csv",
        "theme_leadership.csv",
        "market_leaders.csv",
        "macro_dashboard.csv",
        "macro_axes.csv",
        "economic_events_today.csv",
        "economic_events_upcoming.csv",
        "news_clusters.csv",
        "transmission_signals.csv",
        "market_data_quality.json",
        "market_dashboard.png",
    ]
    missing = [name for name in required if not (output_dir / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing saved report artifacts: {', '.join(missing)}")

    market_state = json.loads((output_dir / "market_state.json").read_text(encoding="utf-8"))
    quality = json.loads((output_dir / "market_data_quality.json").read_text(encoding="utf-8"))
    overview = pd.read_csv(output_dir / "market_overview.csv")
    sectors = pd.read_csv(output_dir / "sector_leadership.csv")
    themes = pd.read_csv(output_dir / "theme_leadership.csv")
    leaders = pd.read_csv(output_dir / "market_leaders.csv")
    macro = pd.read_csv(output_dir / "macro_dashboard.csv")
    macro_axes = pd.read_csv(output_dir / "macro_axes.csv")
    today_events = pd.read_csv(output_dir / "economic_events_today.csv")
    upcoming_events = pd.read_csv(output_dir / "economic_events_upcoming.csv")
    news_clusters = pd.read_csv(output_dir / "news_clusters.csv")
    transmissions = pd.read_csv(output_dir / "transmission_signals.csv")
    indices = overview.loc[overview["category"].eq("주가지수")].copy()
    risks = overview.loc[overview["category"].eq("위험·자산")].copy()
    macro_axes = build_macro_axes(macro, risks, market_state)
    transmissions = build_transmission_signals(macro, risks, sectors, indices, market_state)
    atomic_write_csv(macro_axes, output_dir / "macro_axes.csv")
    atomic_write_csv(transmissions, output_dir / "transmission_signals.csv")

    # The dashboard can be refreshed from local price caches without invoking a provider.
    config = load_config(DEFAULT_CONFIG)
    cached_indices: list[pd.DataFrame] = []
    for ticker in config["indices"].values():
        cache_path = STOCK_CACHE / f"{safe_symbol(str(ticker))}.parquet"
        if not cache_path.exists():
            continue
        cached = pd.read_parquet(cache_path)
        cached["date"] = pd.to_datetime(cached["date"])
        cached_indices.append(cached.loc[cached["date"].le(as_of)].copy())
    if cached_indices:
        plot_market_dashboard(
            pd.concat(cached_indices, ignore_index=True),
            indices,
            sectors,
            themes,
            output_dir,
            config,
        )

    report = render_market_html(
        as_of=as_of,
        market_state=market_state,
        indices=indices,
        risks=risks,
        sectors=sectors,
        themes=themes,
        leaders=leaders,
        macro=macro,
        macro_axes=macro_axes,
        today_events=today_events,
        upcoming_events=upcoming_events,
        news_clusters=news_clusters,
        transmissions=transmissions,
        quality=quality,
    )
    target = output_dir / "MARKET_REPORT.html"
    _write_text_atomic(report, target)
    _write_text_atomic(report, RESULTS_ROOT / "LATEST_MARKET_REPORT.html")
    shutil.copyfile(output_dir / "market_dashboard.png", RESULTS_ROOT / "market_dashboard.png")
    return {
        "html_report": target,
        "latest_html_report": RESULTS_ROOT / "LATEST_MARKET_REPORT.html",
        "source": "saved artifacts only",
        "network_access": False,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=["run", "render-html"], default="run")
    parser.add_argument("--as-of", default=pd.Timestamp.today().strftime("%Y-%m-%d"))
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    as_of = pd.Timestamp(args.as_of).normalize()
    output = args.output or RESULTS_ROOT / f"{as_of:%Y-%m-%d}"
    output = output if output.is_absolute() else PROJECT_ROOT / output
    if args.command == "render-html":
        result = rerender_market_html(output, as_of)
    else:
        config_path = args.config if args.config.is_absolute() else PROJECT_ROOT / args.config
        config = load_config(config_path)
        result = run_market_report(
            MarketRunSettings(
                as_of=as_of,
                history_start=pd.Timestamp(config["data"]["history_start"]),
                output_dir=output,
                config_path=config_path,
                refresh=bool(args.refresh),
            )
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
