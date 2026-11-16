"""Supplementary per-report inputs for the I2 and S1 browser accounts.

Published I1 reports stay immutable. This module publishes a separate object
``portfolio-reports/strategy-inputs/{reportDate}.json`` that holds only the
price-derived values the browser needs to size I2 and to rank S1:

* I2: daily returns (last 252 sessions through the report's US signal session)
  for IVV and the top-ranked I1 candidates, plus the research fee constant.
  The browser solves the same half-Kelly problem as ``src/us_i2_strategy.py``.
* S1: 12-1 momentum and GICS sector for every I1 candidate.

No date/time rule is defined here: the report's own ``signal_market_date`` is
the only cutoff, and no observation after that session is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import pandas as pd

from .io_utils import write_json

SCHEMA_VERSION = 1
RETURN_LOOKBACK = 252
RETURN_MIN_OBSERVATIONS = 126
RETURN_RANK_LIMIT = 40
# Research I2 sizing cost (KOREA_INVESTMENT_STANDARD): (2 x 0.25% + 0.00206%) / 21 sessions.
I2_FEE_DAILY = (2 * 0.0025 + 0.0000206) / 21
S1_POLICY = {
    "ivv_weight": 0.20, "stock_budget": 0.80, "positions": 3, "pool_size": 20,
    "hold_order_rank": 5, "max_names_per_gics_sector": 1,
    "pool_price_weight": 0.20, "price_margin": 0.90,
    "ordering": "mom_12_1", "ordering_source": "F1 2025-12-31 annual selection (MOM), frozen",
}
# Integer-share accounts cannot buy a 20% IVV slice in small accounts (one IVV share
# is several hundred dollars), so browser accounts hold the same S&P 500 exposure
# through a low-priced ETF. IVV stays the signal/sizing proxy inside the reports.
CORE_ETF = {"ticker": "SPYM", "name": "SPDR Portfolio S&P 500 ETF", "proxy_for": "IVV"}
I2_POLICY = {"ivv_weight": 0.20, "stock_cap_each_full_kelly": 0.40, "stock_budget_full_kelly": 0.80,
             "kelly_fraction": 0.5, "lookback": RETURN_LOOKBACK, "min_observations": RETURN_MIN_OBSERVATIONS,
             "fee_daily": I2_FEE_DAILY}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def compute_strategy_inputs(closes: pd.DataFrame, signal_date: str | pd.Timestamp, candidates: list[dict],
                            gics: dict[str, str], *, report_date: str, source: str) -> dict:
    """Derive I2/S1 inputs from closes known on ``signal_date`` (inclusive)."""
    signal = pd.Timestamp(signal_date)
    history = closes.sort_index().loc[:signal]
    if history.empty or history.index[-1] != signal:
        raise ValueError(f"Strategy inputs need the completed US session {signal.date()}")
    if "IVV" not in history or pd.isna(history["IVV"].iloc[-1]):
        raise ValueError("Strategy inputs need IVV on the signal session")
    tickers: dict[str, dict] = {}
    for row in candidates:
        ticker = str(row["ticker"])
        if ticker == "IVV":
            continue
        series = history[ticker] if ticker in history else pd.Series(dtype=float)
        momentum = None
        if len(series) >= 253:
            momentum = _finite(series.iloc[-22] / series.iloc[-253] - 1)
        tickers[ticker] = {"mom_12_1": momentum, "gics_sector": gics.get(ticker) or None}
    ranked = sorted((row for row in candidates if str(row["ticker"]) != "IVV"), key=lambda row: int(row["rank"]))
    names = ["IVV", *[str(row["ticker"]) for row in ranked[:RETURN_RANK_LIMIT] if str(row["ticker"]) in history]]
    window = history[names].pct_change(fill_method=None).iloc[1:].tail(RETURN_LOOKBACK)
    returns = {name: [None if pd.isna(value) else round(float(value), 7) for value in window[name]] for name in names}
    return {
        "schema_version": SCHEMA_VERSION,
        "report_date_kst": report_date,
        "signal_market_date": str(signal.date()),
        "first_return_date": str(window.index[0].date()) if len(window) else None,
        "last_return_date": str(window.index[-1].date()) if len(window) else None,
        "returns": returns,
        "tickers": tickers,
        "i2": I2_POLICY,
        "s1": S1_POLICY,
        "source": source,
    }


def inputs_from_market_data(data, payload: dict) -> dict:
    from .us_daily_portfolio_report import _close_with_anchor
    universe = data.universe.drop_duplicates("ticker").set_index("ticker")
    gics = universe["sector"].astype(str).to_dict() if "sector" in universe else {}
    return compute_strategy_inputs(_close_with_anchor(data), payload["signal_market_date"], payload["candidates"], gics,
                                   report_date=payload["report_date_kst"],
                                   source=f"publication-time cache; universe {data.snapshot_path.name}")


def stage_inputs(store, day: str, inputs: dict) -> None:
    if inputs.get("report_date_kst") != day:
        raise ValueError("Strategy inputs date mismatch")
    store.stage(f"portfolio-reports/strategy-inputs/{day}.json", inputs)


def core_quote_from_frame(frame: pd.DataFrame, signal_date: str, *, report_date: str, source: str) -> dict:
    """Close of the account core ETF on the report's US signal session (exact date only)."""
    signal = pd.Timestamp(signal_date).normalize()
    rows = frame.loc[pd.to_datetime(frame["date"]).dt.normalize().eq(signal)].dropna(subset=["close"])
    close = _finite(rows["close"].iloc[-1]) if not rows.empty else None
    if close is None or close <= 0:
        raise ValueError(f"{CORE_ETF['ticker']} close is missing for US session {signal.date()}")
    return {"schema_version": 1, "report_date_kst": report_date, "signal_market_date": str(signal.date()),
            **CORE_ETF, "close": round(close, 6), "source": source}


def fetch_core_frame(first_signal: str, last_signal: str) -> pd.DataFrame:
    from .support import _download_yahoo_frame
    return _download_yahoo_frame(CORE_ETF["ticker"], pd.Timestamp(first_signal) - pd.Timedelta(days=7),
                                 pd.Timestamp(last_signal) + pd.Timedelta(days=1), timeout=20, max_retries=4)


def core_quote_for_payload(payload: dict) -> dict:
    signal = payload["signal_market_date"]
    return core_quote_from_frame(fetch_core_frame(signal, signal), signal, report_date=payload["report_date_kst"],
                                 source="Yahoo adjusted close collected at publication")


def stage_core_quote(store, day: str, quote: dict) -> None:
    if quote.get("report_date_kst") != day:
        raise ValueError("Core ETF quote date mismatch")
    store.stage(f"portfolio-reports/core-quotes/{day}.json", quote)


# ---------------------------------------------------------------- backfill for already published reports
def _gics_snapshot(day: str) -> Path | None:
    from .support import PROJECT_ROOT, UNIVERSE_CACHE
    paths = [*UNIVERSE_CACHE.glob("sp500_*.parquet"), *(PROJECT_ROOT / "data/reference/portfolio-universe").glob("sp500_*.parquet")]
    dated = sorted((pd.Timestamp(path.stem.split("_")[-1]), path) for path in paths)
    before = [path for stamp, path in dated if stamp < pd.Timestamp(day)]
    return before[-1] if before else (dated[0][1] if dated else None)


def _load_closes(tickers: set[str]) -> pd.DataFrame:
    from .support import STOCK_CACHE, safe_symbol
    columns = {}
    for ticker in sorted(tickers):
        path = STOCK_CACHE / f"{safe_symbol(ticker)}.parquet"
        if not path.exists():
            continue
        frame = pd.read_parquet(path, columns=["date", "close"])
        frame["date"] = pd.to_datetime(frame["date"])
        columns[ticker] = frame.dropna().drop_duplicates("date", keep="last").set_index("date")["close"].astype(float)
    return pd.DataFrame(columns).sort_index()


def _refresh_prices(symbols: set[str], days: list[str], output: Path) -> dict[str, str]:
    """Fill cached price gaps symbol by symbol.

    One unavailable symbol (for example a delisted constituent that Yahoo no
    longer serves) must not abort the backfill: its failure is recorded and the
    already cached closes are used. IVV is still required by
    ``compute_strategy_inputs``, so a missing IVV fails the affected days.
    """
    import tempfile
    from concurrent.futures import ThreadPoolExecutor

    from .repair_portfolio_history import fill_price_gaps

    def refresh(symbol: str):
        with tempfile.TemporaryDirectory() as scratch:
            try:
                return symbol, fill_price_gaps({symbol}, days, Path(scratch)), None
            except Exception as error:  # recorded below, never hidden
                return symbol, [], f"{type(error).__name__}: {error}"

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(refresh, sorted(symbols)))
    failures = {symbol: error for symbol, _, error in results if error}
    audit = [row for _, rows, _ in results for row in rows]
    write_json({"audit": audit, "failures": failures}, output / "historical-price-gaps.json")
    return failures


def _backfill_core_quotes(store, index: dict, days: list[str] | None, output: Path) -> tuple[list[str], dict]:
    sessions = {item["reportDate"]: item["marketDate"] for item in index["reports"]
                if not days or item["reportDate"] in set(days)}
    missing = sorted(day for day in sessions if f"portfolio-reports/core-quotes/{day}.json" not in store.manifest["objects"])
    if not missing:
        return [], {}
    try:
        frame = fetch_core_frame(min(sessions[day] for day in missing), max(sessions[day] for day in missing))
    except Exception as error:  # record, never hide
        return [], {day: f"{type(error).__name__}: {error}" for day in missing}
    done, failed = [], {}
    for day in missing:
        try:
            quote = core_quote_from_frame(frame, sessions[day], report_date=day, source="Yahoo adjusted close (backfill)")
            write_json(quote, output / "core-quotes" / f"{day}.json")
            stage_core_quote(store, day, quote)
            done.append(day)
        except Exception as error:
            failed[day] = str(error)
    return done, failed


def backfill(store, *, output: Path, refresh_prices: bool = False, days: list[str] | None = None) -> dict:
    if not store.manifest.get("dailyStartDate"):
        raise ValueError("Portfolio archive is not initialized; refusing to backfill")
    index = store.load("portfolio-reports/index.json") or {"reports": []}
    wanted = sorted(item["reportDate"] for item in index["reports"])
    if days:
        wanted = [day for day in wanted if day in set(days)]
    missing = [day for day in wanted if f"portfolio-reports/strategy-inputs/{day}.json" not in store.manifest["objects"]]
    reports = {day: store.load(f"portfolio-reports/{day}.json") for day in missing}
    symbols = {"IVV", *(str(row["ticker"]) for report in reports.values() for row in report["candidates"])}
    price_failures = _refresh_prices(symbols, missing, output) if refresh_prices and missing else {}
    closes = _load_closes(symbols)
    done, failed = [], {}
    for day in missing:
        report = reports[day]
        try:
            snapshot = _gics_snapshot(day)
            gics = {}
            if snapshot is not None:
                universe = pd.read_parquet(snapshot)
                gics = dict(zip(universe["ticker"].astype(str).str.upper(), universe["sector"].astype(str)))
            inputs = compute_strategy_inputs(closes, report["signal_market_date"], report["candidates"], gics,
                                             report_date=day, source=f"backfill from cached closes; GICS {snapshot.name if snapshot else 'unavailable'}")
            inputs["reportSha256"] = hashlib.sha256(json.dumps(report, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            write_json(inputs, output / f"{day}.json")
            stage_inputs(store, day, inputs)
            done.append(day)
        except Exception as error:  # record, never hide
            failed[day] = str(error)
    core_done, core_failed = _backfill_core_quotes(store, index, days, output)
    result = {"requested": missing, "staged": done, "failed": failed, "priceRefreshFailed": price_failures,
              "coreQuotesStaged": core_done, "coreQuotesFailed": core_failed}
    if done or core_done:
        store.commit()
    write_json(result, output / "backfill.json")
    return result


def main():
    parser = argparse.ArgumentParser(description="Backfill I2/S1 strategy inputs for published portfolio reports")
    parser.add_argument("--output", type=Path, default=Path("action-output/portfolio-strategy-inputs"))
    parser.add_argument("--refresh-prices", action="store_true")
    parser.add_argument("--day", action="append")
    args = parser.parse_args()
    from .report_store import ReportStore
    args.output.mkdir(parents=True, exist_ok=True)
    result = backfill(ReportStore.from_environment("portfolio"), output=args.output,
                      refresh_prices=args.refresh_prices, days=args.day)
    print(json.dumps(result, ensure_ascii=False))
    if result["failed"] or result["coreQuotesFailed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
