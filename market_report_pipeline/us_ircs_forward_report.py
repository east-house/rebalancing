"""Run the frozen IRCS M/R2 paper accounts and publish dated reports.

The market-report cache is reused as the price source.  R2 is the authoritative
ledger; GitHub Actions cache remains only a download accelerator.  Decisions
made on session t are executed once, at the adjusted close of the next newly
observed US session, and are never recomputed after execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yaml

from .io_utils import write_json
from .support import PROJECT_ROOT, STOCK_CACHE, UNIVERSE_CACHE, safe_symbol


CONFIG_PATH = PROJECT_ROOT / "config" / "ircs-forward.yaml"
MARKET_CONFIG_PATH = PROJECT_ROOT / "config" / "market-report.yaml"
SEED_STATE_PATH = PROJECT_ROOT / "config" / "ircs-forward-seed-state.json"
SEED_CANDIDATES_PATH = PROJECT_ROOT / "config" / "ircs-forward-seed-candidates.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "action-output" / "trading-test-reports"
STATIC_OUTPUT = PROJECT_ROOT / "public" / "data" / "trading-test-reports"
STRATEGIES = ("IRCS-BBCCI-M", "IRCS-BBCCI-M-R2")
KST = ZoneInfo("Asia/Seoul")
PUBLICATION_HOUR_KST = 19


def validate_publication_time(
    as_of: pd.Timestamp,
    now: datetime | None = None,
) -> None:
    """Reject future or premature same-day publication requests."""
    now_kst = (now or datetime.now(timezone.utc)).astimezone(KST)
    report_date = pd.Timestamp(as_of).date()
    if report_date > now_kst.date():
        raise RuntimeError(f"Future report date is not allowed: {report_date}")
    if report_date == now_kst.date() and now_kst.hour < PUBLICATION_HOUR_KST:
        raise RuntimeError(
            f"The {report_date} report may only be published at or after "
            f"{PUBLICATION_HOUR_KST:02d}:00 Asia/Seoul; current time is "
            f"{now_kst:%H:%M}."
        )


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return yaml.safe_load(file) or {}


CONFIG = _load_yaml(CONFIG_PATH)
MARKET_CONFIG = _load_yaml(MARKET_CONFIG_PATH)


@dataclass
class MarketPanel:
    calendar: pd.DatetimeIndex
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame
    universe: pd.DataFrame
    snapshot_path: Path

    @property
    def dollar_volume(self) -> pd.DataFrame:
        return self.close * self.volume


class R2JsonStore:
    def __init__(self, client: Any, bucket: str, prefix: str) -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    @classmethod
    def from_environment(cls, prefix: str) -> "R2JsonStore":
        import boto3

        required = (
            "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET_NAME",
        )
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise RuntimeError(f"Missing R2 configuration: {', '.join(missing)}")
        client = boto3.client(
            "s3",
            endpoint_url=(
                f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
            ),
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        return cls(client, os.environ["R2_BUCKET_NAME"], prefix)

    def key(self, suffix: str) -> str:
        return f"{self.prefix}/{suffix.lstrip('/')}"

    def load(self, suffix: str) -> dict[str, Any] | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self.key(suffix))
        except Exception as error:  # provider exception types vary
            code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        body = response["Body"]
        try:
            return json.loads(body.read().decode("utf-8"))
        finally:
            if hasattr(body, "close"):
                body.close()

    def save(self, suffix: str, payload: dict[str, Any]) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), default=str
        ).encode("utf-8")
        self.client.put_object(
            Bucket=self.bucket,
            Key=self.key(suffix),
            Body=body,
            ContentType="application/json; charset=utf-8",
            CacheControl=(
                "private, no-store"
                if suffix.startswith("state/")
                else "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
                if suffix in {"index.json", "latest.json"}
                else "public, max-age=31536000, immutable"
            ),
        )


def _read_price(path: Path, ticker: str) -> pd.DataFrame:
    frame = pd.read_parquet(path)
    required = {"date", "open", "high", "low", "close", "volume"}
    if not required.issubset(frame.columns):
        return pd.DataFrame()
    result = frame[["date", "open", "high", "low", "close", "volume"]].copy()
    result["date"] = pd.to_datetime(result["date"])
    result["ticker"] = ticker
    return result.dropna(subset=["date", "close"]).sort_values("date")


def _required_proxy_symbols() -> set[str]:
    result = {"IVV"}
    for group in ("sector_proxies", "themes"):
        for value in MARKET_CONFIG.get(group, {}).values():
            result.add(str(value["proxy"] if isinstance(value, dict) else value).upper())
    return result


def load_market_panel(as_of: pd.Timestamp) -> tuple[MarketPanel, dict[str, Any]]:
    snapshots = sorted(UNIVERSE_CACHE.glob("sp500_*.parquet"))
    if not snapshots:
        raise FileNotFoundError("S&P 500 universe snapshot is missing")
    eligible_snapshots = [
        path for path in snapshots
        if pd.Timestamp(path.stem.split("_")[-1]) <= as_of
    ]
    snapshot_path = eligible_snapshots[-1] if eligible_snapshots else snapshots[-1]
    universe = pd.read_parquet(snapshot_path).copy()
    universe["ticker"] = universe["ticker"].astype(str).str.upper()
    symbols = set(universe["ticker"]) | _required_proxy_symbols()

    rows: list[pd.DataFrame] = []
    missing: list[str] = []
    for ticker in sorted(symbols):
        path = STOCK_CACHE / f"{safe_symbol(ticker)}.parquet"
        if not path.exists():
            missing.append(ticker)
            continue
        frame = _read_price(path, ticker)
        if frame.empty:
            missing.append(ticker)
        else:
            rows.append(frame)
    if "IVV" in missing:
        raise FileNotFoundError("IVV adjusted OHLC is required")

    prices = pd.concat(rows, ignore_index=True).drop_duplicates(
        ["date", "ticker"], keep="last"
    )
    latest = prices.loc[prices["ticker"].eq("IVV"), "date"].max()
    if pd.isna(latest):
        raise RuntimeError("IVV market date is unavailable")
    # A report runs at 19:00 KST while the same-calendar-date US session has
    # not closed.  Never accept Yahoo's live partial daily candle as a close.
    latest = min(pd.Timestamp(latest), as_of.normalize() - pd.offsets.Day(1))
    calendar = pd.DatetimeIndex(
        prices.loc[prices["ticker"].eq("IVV") & prices["date"].le(latest), "date"]
        .drop_duplicates()
        .sort_values()
    )
    matrices = {
        field: prices.pivot(index="date", columns="ticker", values=field)
        .reindex(calendar)
        .astype(float)
        for field in ("open", "high", "low", "close", "volume")
    }
    latest_members = set(universe["ticker"])
    covered = [
        ticker for ticker in latest_members
        if ticker in matrices["close"] and pd.notna(matrices["close"].at[latest, ticker])
    ]
    coverage = len(covered) / max(len(latest_members), 1)
    minimum = float(CONFIG["universe"]["minimum_latest_coverage"])
    if coverage < minimum:
        raise RuntimeError(
            f"Latest constituent coverage {coverage:.2%} is below {minimum:.2%}"
        )
    panel = MarketPanel(
        calendar=calendar,
        open=matrices["open"],
        high=matrices["high"],
        low=matrices["low"],
        close=matrices["close"],
        volume=matrices["volume"],
        universe=universe,
        snapshot_path=snapshot_path,
    )
    return panel, {
        "marketDate": str(latest.date()),
        "universeCount": len(latest_members),
        "latestCoverage": coverage,
        "missingSymbols": missing,
        "snapshot": snapshot_path.name,
    }


def _indicators(panel: MarketPanel) -> dict[str, pd.DataFrame]:
    typical = (panel.high + panel.low + panel.close) / 3.0
    average = typical.rolling(20, min_periods=20).mean()
    deviation = typical.rolling(20, min_periods=20).apply(
        lambda values: float(np.mean(np.abs(values - np.mean(values)))), raw=True
    )
    cci = (typical - average) / (0.015 * deviation.replace(0.0, np.nan))
    signal = cci.rolling(9, min_periods=9).mean()
    middle = panel.close.rolling(20, min_periods=20).mean()
    std = panel.close.rolling(20, min_periods=20).std(ddof=0)
    return {
        "cci": cci,
        "signal": signal,
        "middle": middle,
        "lower": middle - 2.0 * std,
    }


def _signals(panel: MarketPanel, indicators: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    cci = indicators["cci"]
    signal = indicators["signal"]
    lower_contact = (panel.close <= indicators["lower"]).rolling(10, min_periods=1).max().astype(bool)
    threshold_cross = (cci.shift(1) < -100.0) & (cci >= -100.0)
    signal_cross = (cci.shift(1) <= signal.shift(1)) & (cci > signal)
    entry = (
        lower_contact
        & threshold_cross.rolling(3, min_periods=1).max().astype(bool)
        & signal_cross.rolling(3, min_periods=1).max().astype(bool)
        & (cci > signal)
        & (panel.close < indicators["middle"])
    )
    denominator = (indicators["middle"] - indicators["lower"]).replace(0.0, np.nan)
    return {
        "entry": entry.fillna(False),
        "cciGap": cci - signal,
        "bandPosition": (panel.close - indicators["lower"]) / denominator,
    }


def _completed_month_end(signal_date: pd.Timestamp, calendar: pd.DatetimeIndex) -> pd.Timestamp:
    cutoff = signal_date.to_period("M").start_time - pd.offsets.Day(1)
    dates = calendar[calendar <= cutoff]
    if dates.empty:
        raise RuntimeError("No completed month-end is available")
    return pd.Timestamp(dates[-1])


def _best_proxy(
    stock_excess: pd.DataFrame,
    proxy_excess: pd.DataFrame,
    minimum_correlation: float,
) -> tuple[pd.Series, pd.Series]:
    labels = {proxy: f"Proxy::{proxy}" for proxy in proxy_excess}
    joined = stock_excess.join(proxy_excess.rename(columns=labels), how="inner")
    corr = joined.corr(min_periods=60).reindex(
        index=stock_excess.columns, columns=list(labels.values())
    )
    corr.columns = list(labels)
    best = corr.idxmax(axis=1)
    value = corr.max(axis=1)
    return best.where(value.ge(minimum_correlation)), value


def _candidate_rows_from_seed(candidate_date: pd.Timestamp) -> list[dict[str, Any]] | None:
    if not SEED_CANDIDATES_PATH.exists():
        return None
    payload = json.loads(SEED_CANDIDATES_PATH.read_text(encoding="utf-8"))
    if payload.get("candidateDate") != str(candidate_date.date()):
        return None
    return list(payload.get("candidates", []))


def build_candidate_table(panel: MarketPanel, signal_date: pd.Timestamp) -> tuple[pd.Timestamp, pd.DataFrame]:
    date = _completed_month_end(signal_date, panel.calendar)
    seeded = _candidate_rows_from_seed(date)
    if seeded:
        return date, pd.DataFrame(seeded).set_index("ticker")

    names = [ticker for ticker in panel.universe["ticker"].astype(str) if ticker in panel.close]
    close = panel.close[names]
    returns = close.pct_change(fill_method=None)
    frame = pd.DataFrame(index=names)
    frame["mom_12_1"] = (close.shift(21) / close.shift(252) - 1.0).loc[date]
    frame["mom_6_1"] = (close.shift(21) / close.shift(126) - 1.0).loc[date]
    frame["mom_3_1"] = (close.shift(21) / close.shift(63) - 1.0).loc[date]
    frame["vol_63"] = (returns.rolling(63, min_periods=50).std() * math.sqrt(252)).loc[date]
    frame["trend_200"] = (close / close.rolling(200, min_periods=180).mean() - 1.0).loc[date]
    frame["adv_63"] = panel.dollar_volume[names].rolling(63, min_periods=40).mean().loc[date]
    frame["raw_close"] = close.loc[date]
    frame = frame.dropna().loc[
        lambda value: value["raw_close"].ge(float(CONFIG["universe"]["minimum_price"]))
        & value["adv_63"].ge(float(CONFIG["universe"]["minimum_dollar_volume_63"]))
        & value["vol_63"].le(float(CONFIG["universe"]["maximum_annualized_volatility"]))
    ].copy()
    if len(frame) < 5:
        raise RuntimeError("Fewer than five IRCS monthly candidates passed")

    market_returns = panel.close["IVV"].pct_change(fill_method=None)
    stock_window = returns.loc[:date, frame.index].tail(126)
    stock_excess = stock_window.sub(market_returns.reindex(stock_window.index), axis=0)
    theme_map = {
        str(definition["proxy"]).upper(): str(name)
        for name, definition in MARKET_CONFIG.get("themes", {}).items()
    }
    sector_map = {
        str(proxy).upper(): str(name)
        for name, proxy in MARKET_CONFIG.get("sector_proxies", {}).items()
    }
    proxy_close = panel.close.reindex(columns=sorted(set(theme_map) | set(sector_map))).ffill()
    proxy_excess = proxy_close.pct_change(fill_method=None).reindex(stock_window.index).sub(
        market_returns.reindex(stock_window.index), axis=0
    )
    theme_proxy, _ = _best_proxy(stock_excess, proxy_excess.reindex(columns=list(theme_map)), 0.30)
    sector_proxy, _ = _best_proxy(stock_excess, proxy_excess.reindex(columns=list(sector_map)), 0.20)
    frame["theme"] = [
        theme_map.get(str(theme_proxy.get(ticker)), f"Unmapped::{ticker}")
        for ticker in frame.index
    ]
    frame["sector"] = [
        sector_map.get(str(sector_proxy.get(ticker)), f"Unknown::{ticker}")
        for ticker in frame.index
    ]
    frame.index.name = "ticker"
    return date, frame[["adv_63", "raw_close", "vol_63", "theme", "sector"]]


def _theme_bucket(row: pd.Series, ticker: str) -> str:
    theme = str(row.get("theme", ""))
    if theme and not theme.startswith("Unmapped::") and theme.lower() != "nan":
        return f"Theme::{theme}"
    sector = str(row.get("sector", ""))
    if sector and not sector.startswith("Unknown::") and sector.lower() != "nan":
        return f"Sector::{sector}"
    return f"Unmapped::{ticker}"


def _market_gate(
    date: pd.Timestamp,
    panel: MarketPanel,
    indicators: dict[str, pd.DataFrame],
    strategy: str,
) -> tuple[bool, dict[str, float | bool]]:
    cci = float(indicators["cci"].at[date, "IVV"])
    previous_cci = float(indicators["cci"]["IVV"].shift(1).at[date])
    lower = float(indicators["lower"].at[date, "IVV"])
    middle = float(indicators["middle"].at[date, "IVV"])
    close = float(panel.close.at[date, "IVV"])
    band = (close - lower) / (middle - lower)
    gate_cfg = CONFIG["market_gate"]
    base = (
        float(gate_cfg["cci_minimum"]) <= cci <= float(gate_cfg["cci_maximum"])
        and float(gate_cfg["band_position_minimum"]) <= band <= float(gate_cfg["band_position_maximum"])
    )
    rising = cci > previous_cci
    opened = base and (strategy == "IRCS-BBCCI-M" or rising)
    return opened, {
        "baseOpen": base,
        "cciRising": rising,
        "ivvCci": cci,
        "ivvCciChange": cci - previous_cci,
        "ivvBandPosition": band,
        "ivvClose": close,
    }


def make_decision(
    strategy: str,
    account: dict[str, Any],
    date: pd.Timestamp,
    panel: MarketPanel,
    indicators: dict[str, pd.DataFrame],
    signals: dict[str, pd.DataFrame],
    candidate_snapshots: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    expected_candidate_date = _completed_month_end(date, panel.calendar)
    candidate_key = str(expected_candidate_date.date())
    cached_rows = (candidate_snapshots or {}).get(candidate_key)
    if cached_rows:
        candidate_date = expected_candidate_date
        table = pd.DataFrame(cached_rows).set_index("ticker")
    else:
        candidate_date, table = build_candidate_table(panel, date)
        if candidate_snapshots is not None:
            candidate_snapshots[candidate_key] = table.reset_index().where(
                table.reset_index().notna(), None
            ).to_dict(orient="records")
    positions = account["positions"]
    orders: list[dict[str, Any]] = []
    exiting: set[str] = set()
    current_members = set(panel.universe["ticker"].astype(str))
    for ticker, position in positions.items():
        if ticker not in current_members:
            orders.append({"side": "SELL", "ticker": ticker, "reason": "left_sp500_universe"})
            exiting.add(ticker)
        elif (
            ticker in panel.close
            and pd.notna(panel.close.at[date, ticker])
            and float(panel.close.at[date, ticker]) >= float(indicators["middle"].at[date, ticker])
        ):
            orders.append({"side": "SELL", "ticker": ticker, "reason": "middle_band_target"})
            exiting.add(ticker)

    gate_open, market = _market_gate(date, panel, indicators, strategy)
    remaining = {ticker: value for ticker, value in positions.items() if ticker not in exiting}
    free_slots = int(CONFIG["strategy"]["maximum_positions"]) - len(remaining)
    raw_signals = 0
    if gate_open and free_slots > 0:
        minimum_room = (
            float(CONFIG["r2"]["minimum_target_room"])
            if strategy == "IRCS-BBCCI-M-R2" else 0.0
        )
        eligible = [
            ticker for ticker in table.index.astype(str)
            if ticker not in remaining
            and ticker in signals["entry"]
            and bool(signals["entry"].at[date, ticker])
            and pd.notna(panel.close.at[date, ticker])
            and (
                float(indicators["middle"].at[date, ticker])
                / float(panel.close.at[date, ticker]) - 1.0
            ) >= minimum_room
        ]
        raw_signals = len(eligible)
        if eligible:
            universe = table.index.intersection(signals["cciGap"].columns)
            cci_pct = signals["cciGap"].loc[date, universe].rank(pct=True)
            band_pct = signals["bandPosition"].loc[date, universe].rank(pct=True)
            adv_pct = table.loc[universe, "adv_63"].rank(pct=True)
            ranking = table.loc[eligible].copy()
            ranking["ircs_score"] = (
                ranking.index.to_series().map(cci_pct) * 0.60
                + ranking.index.to_series().map(band_pct) * 0.25
                + ranking.index.to_series().map(adv_pct) * 0.15
            )
            ranking = ranking.sort_values(["ircs_score", "adv_63"], ascending=False)
            occupied = {value["themeBucket"] for value in remaining.values()}
            for ticker, row in ranking.iterrows():
                bucket = _theme_bucket(row, str(ticker))
                if bucket in occupied:
                    continue
                orders.append({
                    "side": "BUY",
                    "ticker": str(ticker),
                    "reason": "ircs_entry",
                    "themeBucket": bucket,
                    "score": float(row["ircs_score"]),
                    "signalClose": float(panel.close.at[date, ticker]),
                    "targetRoom": float(
                        indicators["middle"].at[date, ticker] / panel.close.at[date, ticker] - 1.0
                    ),
                })
                occupied.add(bucket)
                if sum(order["side"] == "BUY" for order in orders) >= free_slots:
                    break
    return {
        "signalDate": str(date.date()),
        "candidateDate": str(candidate_date.date()),
        "strategy": strategy,
        "marketGate": {"open": gate_open, **market},
        "rawSignals": raw_signals,
        "orders": orders,
        "summary": "주문 없음 · 현금/보유 유지" if not orders else f"{len(orders)}건 실행 예정",
    }


def _new_account(capital: float) -> dict[str, Any]:
    return {
        "initialCapital": capital,
        "cash": capital,
        "positions": {},
        "feesPaid": 0.0,
        "realizedPnl": 0.0,
        "peakEquity": capital,
        "maxDrawdown": 0.0,
        "closedTrades": [],
        "transactions": [],
    }


def load_seed_state() -> dict[str, Any]:
    if SEED_STATE_PATH.exists():
        return json.loads(SEED_STATE_PATH.read_text(encoding="utf-8"))
    capital = float(CONFIG["strategy"]["initial_capital_each"])
    initialized = str(CONFIG["strategy"]["initial_signal_date"])
    return {
        "schemaVersion": 1,
        "strategyVersion": CONFIG["strategy"]["version"],
        "initializedSignalDate": initialized,
        "lastProcessedMarketDate": initialized,
        "accounts": {strategy: _new_account(capital) for strategy in STRATEGIES},
        "pendingDecisions": {
            strategy: {
                "signalDate": initialized,
                "strategy": strategy,
                "orders": [],
                "summary": "주문 없음 · 현금 유지",
            }
            for strategy in STRATEGIES
        },
        "candidateSnapshots": {},
    }


def _position_value(account: dict[str, Any], date: pd.Timestamp, close: pd.DataFrame) -> float:
    return sum(
        float(position["shares"]) * float(close.at[date, ticker])
        for ticker, position in account["positions"].items()
        if ticker in close and pd.notna(close.at[date, ticker])
    )


def execute_pending(
    account: dict[str, Any],
    decision: dict[str, Any],
    execution_date: pd.Timestamp,
    close: pd.DataFrame,
) -> list[dict[str, Any]]:
    cost_rate = float(CONFIG["strategy"]["one_way_cost"])
    completed: list[dict[str, Any]] = []
    orders = list(decision.get("orders", []))
    for order in [item for item in orders if item["side"] == "SELL"]:
        ticker = order["ticker"]
        position = account["positions"].get(ticker)
        price = close.at[execution_date, ticker] if ticker in close else np.nan
        if position is None or pd.isna(price):
            raise RuntimeError(f"Cannot execute SELL {ticker} on {execution_date.date()}")
        price = float(price)
        notional = float(position["shares"]) * price
        fee = notional * cost_rate
        proceeds = notional - fee
        net_pnl = proceeds - float(position["costBasis"])
        account["cash"] += proceeds
        account["feesPaid"] += fee
        account["realizedPnl"] += net_pnl
        account["closedTrades"].append({
            "ticker": ticker,
            "entryDate": position["entryDate"],
            "exitDate": str(execution_date.date()),
            "netPnl": net_pnl,
            "netReturn": net_pnl / float(position["costBasis"]),
        })
        del account["positions"][ticker]
        completed.append({
            "side": "SELL", "ticker": ticker, "shares": position["shares"],
            "price": price, "notional": notional, "fee": fee,
            "netPnl": net_pnl, "reason": order["reason"],
        })

    marked = float(account["cash"]) + _position_value(account, execution_date, close)
    target = marked / int(CONFIG["strategy"]["maximum_positions"])
    for order in [item for item in orders if item["side"] == "BUY"]:
        ticker = order["ticker"]
        price = close.at[execution_date, ticker] if ticker in close else np.nan
        if pd.isna(price):
            raise RuntimeError(f"Cannot execute BUY {ticker} on {execution_date.date()}")
        price = float(price)
        affordable = max(float(account["cash"]), 0.0) / (1.0 + cost_rate)
        notional = min(target, affordable)
        shares = math.floor((notional / price) * 1000.0) / 1000.0
        if shares < 0.0005:
            continue
        notional = shares * price
        fee = notional * cost_rate
        account["cash"] -= notional + fee
        account["feesPaid"] += fee
        account["positions"][ticker] = {
            "ticker": ticker,
            "shares": shares,
            "entryPrice": price,
            "entryDate": str(execution_date.date()),
            "entryFee": fee,
            "costBasis": notional + fee,
            "themeBucket": order["themeBucket"],
        }
        completed.append({
            "side": "BUY", "ticker": ticker, "shares": shares,
            "price": price, "notional": notional, "fee": fee,
            "reason": order["reason"], "themeBucket": order["themeBucket"],
        })
    if not completed:
        completed.append({
            "side": "HOLD", "ticker": None, "shares": 0.0, "price": None,
            "notional": 0.0, "fee": 0.0, "reason": "no_pending_orders",
        })
    for item in completed:
        account["transactions"].append({
            "signalDate": decision.get("signalDate"),
            "executionDate": str(execution_date.date()),
            **item,
        })
    return completed


def account_snapshot(
    account: dict[str, Any], date: pd.Timestamp, close: pd.DataFrame
) -> dict[str, Any]:
    positions: list[dict[str, Any]] = []
    market_value = 0.0
    for ticker, position in account["positions"].items():
        price = float(close.at[date, ticker])
        value = float(position["shares"]) * price
        pnl = value - float(position["costBasis"])
        market_value += value
        positions.append({
            **position,
            "currentPrice": price,
            "marketValue": value,
            "unrealizedPnl": pnl,
            "unrealizedReturn": pnl / float(position["costBasis"]),
        })
    equity = float(account["cash"]) + market_value
    account["peakEquity"] = max(float(account["peakEquity"]), equity)
    drawdown = equity / float(account["peakEquity"]) - 1.0
    account["maxDrawdown"] = min(float(account["maxDrawdown"]), drawdown)
    closed = account["closedTrades"]
    wins = [trade for trade in closed if float(trade["netPnl"]) > 0]
    gross_profit = sum(max(float(trade["netPnl"]), 0.0) for trade in closed)
    gross_loss = -sum(min(float(trade["netPnl"]), 0.0) for trade in closed)
    return {
        "cash": float(account["cash"]),
        "marketValue": market_value,
        "equity": equity,
        "totalReturn": equity / float(account["initialCapital"]) - 1.0,
        "realizedPnl": float(account["realizedPnl"]),
        "unrealizedPnl": sum(item["unrealizedPnl"] for item in positions),
        "feesPaid": float(account["feesPaid"]),
        "positions": positions,
        "positionCount": len(positions),
        "closedTrades": len(closed),
        "winRate": len(wins) / len(closed) if closed else None,
        "profitFactor": gross_profit / gross_loss if gross_loss > 0 else None,
        "maxDrawdown": float(account["maxDrawdown"]),
    }


def build_report(
    date: pd.Timestamp,
    state: dict[str, Any],
    completed: dict[str, list[dict[str, Any]]],
    next_decisions: dict[str, dict[str, Any]],
    panel: MarketPanel,
    quality: dict[str, Any],
) -> dict[str, Any]:
    accounts = {
        strategy: account_snapshot(state["accounts"][strategy], date, panel.close)
        for strategy in STRATEGIES
    }
    start = pd.Timestamp(state["initializedSignalDate"])
    ivv_start = float(panel.close["IVV"].dropna().loc[:start].iloc[-1])
    ivv_close = float(panel.close.at[date, "IVV"])
    display_date = date + pd.offsets.Day(1)
    return {
        "schemaVersion": 1,
        "strategyVersion": state["strategyVersion"],
        "reportDate": str(display_date.date()),
        "marketDate": str(date.date()),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "executionPriceBasis": "split/dividend-adjusted close",
        "oneWayCost": float(CONFIG["strategy"]["one_way_cost"]),
        "accounts": accounts,
        "completedActions": completed,
        "nextActions": next_decisions,
        "benchmark": {
            "ticker": "IVV",
            "initialClose": ivv_start,
            "currentClose": ivv_close,
            "totalReturn": ivv_close / ivv_start - 1.0,
        },
        "dataQuality": quality,
        "audit": {
            "ruleHash": hashlib.sha256(
                CONFIG_PATH.read_bytes()
                + Path(__file__).read_bytes()
                + SEED_CANDIDATES_PATH.read_bytes()
            ).hexdigest(),
            "candidateDates": sorted(state.get("candidateSnapshots", {})),
        },
        "disclaimer": "실제 주문이 아닌 조정종가 기반 포워드 가상계좌입니다.",
    }


def _report_index_item(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "reportDate": report["reportDate"],
        "marketDate": report["marketDate"],
        "generatedAt": report["generatedAt"],
        "mEquity": report["accounts"]["IRCS-BBCCI-M"]["equity"],
        "r2Equity": report["accounts"]["IRCS-BBCCI-M-R2"]["equity"],
        "mNextActionCount": len(report["nextActions"]["IRCS-BBCCI-M"]["orders"]),
        "r2NextActionCount": len(report["nextActions"]["IRCS-BBCCI-M-R2"]["orders"]),
    }


def _merge_index(existing: dict[str, Any] | None, reports: list[dict[str, Any]]) -> dict[str, Any]:
    items = {
        item["reportDate"]: item
        for item in (existing or {}).get("reports", [])
        if isinstance(item, dict) and item.get("reportDate")
    }
    for report in reports:
        items[report["reportDate"]] = _report_index_item(report)
    ordered = sorted(items.values(), key=lambda item: item["reportDate"], reverse=True)
    return {
        "schemaVersion": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "latestReportDate": ordered[0]["reportDate"] if ordered else None,
        "reports": ordered,
    }


def run(
    as_of: pd.Timestamp,
    output_dir: Path = DEFAULT_OUTPUT,
    *,
    upload_r2: bool = False,
    publish_static: bool = False,
    reset_ledger: bool = False,
) -> dict[str, Any]:
    panel, quality = load_market_panel(as_of)
    latest = pd.Timestamp(quality["marketDate"])
    indicators = _indicators(panel)
    signals = _signals(panel, indicators)
    prefix = str(CONFIG["storage"]["prefix"])
    store = R2JsonStore.from_environment(prefix) if upload_r2 else None
    stored_state = None if reset_ledger else (store.load("state/latest.json") if store else None)
    state = stored_state or load_seed_state()
    is_new_ledger = stored_state is None
    last = pd.Timestamp(state["lastProcessedMarketDate"])
    pending = state.get("pendingDecisions", {})
    candidate_snapshots = state.setdefault("candidateSnapshots", {})
    if not all(
        strategy in pending and "marketGate" in pending[strategy]
        for strategy in STRATEGIES
    ):
        if last not in panel.calendar:
            raise RuntimeError(f"Seed signal date {last.date()} is absent from the market calendar")
        state["pendingDecisions"] = {
            strategy: make_decision(
                strategy, state["accounts"][strategy], last, panel, indicators, signals,
                candidate_snapshots,
            )
            for strategy in STRATEGIES
        }
    process_dates = panel.calendar[(panel.calendar > last) & (panel.calendar <= latest)]
    reports: list[dict[str, Any]] = []

    # Preserve the declared first day in the archive even when the first
    # production run happens one or more US sessions later than the seed.
    if is_new_ledger and latest > last:
        seed_quality = {**quality, "marketDate": str(last.date())}
        reports.append(build_report(
            last,
            state,
            {strategy: [] for strategy in STRATEGIES},
            state["pendingDecisions"],
            panel,
            seed_quality,
        ))

    if process_dates.empty and latest == last:
        completed = {strategy: [] for strategy in STRATEGIES}
        decisions = state["pendingDecisions"]
        reports.append(build_report(latest, state, completed, decisions, panel, quality))

    for date in process_dates:
        date = pd.Timestamp(date)
        completed = {
            strategy: execute_pending(
                state["accounts"][strategy],
                state["pendingDecisions"][strategy],
                date,
                panel.close,
            )
            for strategy in STRATEGIES
        }
        decisions = {
            strategy: make_decision(
                strategy, state["accounts"][strategy], date, panel, indicators, signals,
                candidate_snapshots,
            )
            for strategy in STRATEGIES
        }
        state["pendingDecisions"] = decisions
        state["lastProcessedMarketDate"] = str(date.date())
        reports.append(build_report(date, state, completed, decisions, panel, quality))

    if not reports:
        raise RuntimeError("No report could be generated")
    existing_index = None if reset_ledger else (store.load("index.json") if store else None)
    index = _merge_index(existing_index, reports)
    output_dir.mkdir(parents=True, exist_ok=True)
    for report in reports:
        write_json(report, output_dir / f"{report['reportDate']}.json")
    write_json(reports[-1], output_dir / "latest.json")
    write_json(index, output_dir / "index.json")
    write_json(state, output_dir / "state.json")

    if publish_static:
        STATIC_OUTPUT.mkdir(parents=True, exist_ok=True)
        write_json(reports[-1], STATIC_OUTPUT / "latest.json")
        write_json(index, STATIC_OUTPUT / "index.json")
        for report in reports:
            write_json(report, STATIC_OUTPUT / f"{report['reportDate']}.json")
    if store:
        for report in reports:
            store.save(f"reports/{report['reportDate']}.json", report)
        store.save("latest.json", reports[-1])
        store.save("index.json", index)
        store.save("state/latest.json", state)
    return {"state": state, "reports": reports, "index": index}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", default="today")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--upload-r2", action="store_true")
    parser.add_argument("--publish-static", action="store_true")
    parser.add_argument(
        "--reset-ledger",
        action="store_true",
        help="Ignore the stored R2 ledger and rebuild every report from the frozen seed.",
    )
    args = parser.parse_args()
    as_of = pd.Timestamp.today().normalize() if args.as_of == "today" else pd.Timestamp(args.as_of)
    validate_publication_time(as_of)
    result = run(
        as_of,
        args.output_dir,
        upload_r2=bool(args.upload_r2),
        publish_static=bool(args.publish_static),
        reset_ledger=bool(args.reset_ledger),
    )
    latest = result["reports"][-1]
    checksum = hashlib.sha256(
        json.dumps(latest, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    print(json.dumps({
        "reportDate": latest["reportDate"],
        "mEquity": latest["accounts"]["IRCS-BBCCI-M"]["equity"],
        "r2Equity": latest["accounts"]["IRCS-BBCCI-M-R2"]["equity"],
        "sha256": checksum,
        "r2Uploaded": bool(args.upload_r2),
        "ledgerReset": bool(args.reset_ledger),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
