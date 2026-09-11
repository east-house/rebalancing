"""Read-only, source-audited IRCS replays; never writes the production ledger."""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import us_ircs_forward_report as engine
from .io_utils import write_json
from .report_time import expected_market_date, korean_today, market_calendar

FIELDS = ["open", "high", "low", "close", "volume"]
MIN_START = pd.Timestamp("2026-08-31")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_bars(frame: pd.DataFrame) -> pd.Series:
    values = frame[FIELDS].apply(pd.to_numeric, errors="coerce")
    return (
        pd.Series(np.isfinite(values).all(axis=1), index=frame.index)
        & values[["open", "high", "low", "close"]].gt(0).all(axis=1)
        & values.volume.ge(0)
        & values.high.ge(values[["open", "close", "low"]].max(axis=1) - 1e-7)
        & values.low.le(values[["open", "close", "high"]].min(axis=1) + 1e-7)
    )


def merge_sources(paths: list[Path]) -> tuple[pd.DataFrame, dict]:
    """Keep complete primary bars. Replace only invalid/missing whole bars."""
    frames = []
    sources = []
    repairs = []
    existing = set()
    for rank, path in enumerate(paths):
        frame = pd.read_parquet(path).copy()
        frame["date"] = pd.to_datetime(frame.date)
        if frame.date.dt.tz is not None:
            raise ValueError("Replay input dates must be timezone-free US session labels")
        if not frame.date.eq(frame.date.dt.normalize()).all():
            raise ValueError("Replay input dates must not contain intraday timestamps")
        if frame.duplicated(["date", "ticker"]).any():
            raise ValueError(f"Duplicate price keys: {path.name}")
        frame = frame.loc[valid_bars(frame)].copy()
        source = {"file": path.name, "sha256": digest(path), "priority": rank}
        sources.append(source)
        keys = list(zip(frame.date, frame.ticker))
        keep = [key not in existing for key in keys]
        added = frame.loc[keep].copy()
        if rank:
            repairs.extend({"date": str(row.date.date()), "ticker": row.ticker, "source": rank}
                           for row in added.itertuples())
        existing.update(keys)
        added["sourceIndex"] = rank
        frames.append(added)
    if not frames:
        raise ValueError("No price sources")
    return pd.concat(frames, ignore_index=True), {"sources": sources, "supplementedRows": repairs}


def prepare_panel(prices: pd.DataFrame, catalog: dict, start: pd.Timestamp, end: pd.Timestamp):
    if start < MIN_START or end < start:
        raise ValueError("Start must be on/after 2026-08-31 and on/before the completed end session")
    if start < pd.Timestamp(catalog["validFrom"]) or end > pd.Timestamp(catalog["verifiedThrough"]):
        raise ValueError("Historical membership evidence does not cover the requested interval")
    universe = pd.DataFrame(catalog["members"])
    if universe.ticker.duplicated().any() or len(universe) < 490:
        raise ValueError("Invalid historical constituent table")
    symbols = sorted(set(universe.ticker) | engine._required_proxy_symbols())
    calendar = market_calendar(end.year).sessions_in_range(prices.date.min(), end).tz_localize(None)
    sessions = calendar[calendar >= start]
    if sessions.empty:
        raise ValueError("No completed US session on/after start")
    first = sessions[0]
    month_end = engine._completed_month_end(first, calendar)
    anchor = first if engine._candidate_rows_from_seed(month_end) else month_end
    pos = calendar.get_loc(anchor)
    if pos < 252:
        raise ValueError("At least 252 prior US sessions are needed")
    warmup = calendar[pos - 252]
    matrices = {field: prices.pivot(index="date", columns="ticker", values=field)
                .reindex(index=calendar, columns=symbols).astype(float) for field in FIELDS}
    approved = catalog.get("listingHistory", {})
    gaps = []
    not_yet_traded = []
    for symbol in symbols:
        required = calendar[calendar >= warmup]
        entry = approved.get(symbol)
        if entry:
            begins = pd.Timestamp(entry["firstTradingSession"])
            if not entry.get("source"):
                raise ValueError(f"Missing listing evidence: {symbol}")
            absent = required[required < begins]
            not_yet_traded.append({"ticker": symbol, "firstTradingSession": str(begins.date()),
                                  "preTradingSessions": len(absent), "source": entry["source"]})
            required = required[required >= begins]
        values = pd.DataFrame({field: matrix.loc[required, symbol] for field, matrix in matrices.items()})
        for date in values.index[~valid_bars(values)]:
            gaps.append({"date": str(date.date()), "ticker": symbol})
    audit = {"status": "failed" if gaps else "passed", "warmupStart": str(warmup.date()),
             "firstSignalSession": str(first.date()), "lastSession": str(end.date()),
             "symbolCount": len(symbols), "checkedSessions": len(calendar[calendar >= warmup]),
             "missingBars": gaps, "listingHistory": not_yet_traded}
    if gaps:
        raise ValueError(f"Incomplete replay inputs: {json.dumps(audit, ensure_ascii=False)}")
    panel = engine.MarketPanel(calendar=calendar, universe=universe,
                              snapshot_path=Path(catalog["sourceRevision"]), **matrices)
    return panel, audit


def validate_indicators(panel, indicators, signals, sessions, snapshots):
    exclusions = {}
    for date in sessions:
        month = engine._completed_month_end(date, panel.calendar)
        key = str(month.date())
        if key not in snapshots:
            _, table = engine.build_candidate_table(panel, date)
            snapshots[key] = table.reset_index().to_dict(orient="records")
            exclusions[key] = sorted(set(panel.universe.ticker) - set(table.index))
        else:
            table = pd.DataFrame(snapshots[key]).set_index("ticker")
        relevant = table.index.intersection(panel.universe.ticker)
        for name, frame in {**indicators, "cciGap": signals["cciGap"], "bandPosition": signals["bandPosition"]}.items():
            values = frame.loc[date, relevant]
            invalid = ~np.isfinite(values)
            if invalid.any():
                raise ValueError(f"Invalid {name} at {date.date()}: {values.index[invalid].tolist()}")
        ivv = indicators["cci"]["IVV"].loc[:date].tail(2)
        if len(ivv) != 2 or not np.isfinite(ivv).all():
            raise ValueError("IVV gate has insufficient history")
    return exclusions


def replay(panel, audit, start: pd.Timestamp, *, prepared=None) -> dict:
    sessions = panel.calendar[panel.calendar >= start]
    if sessions.empty:
        raise ValueError("No completed session")
    first = sessions[0]
    if prepared is None:
        indicators = engine._indicators(panel)
        signals = engine._signals(panel, indicators)
        snapshots = {}
        exclusions = validate_indicators(panel, indicators, signals, sessions, snapshots)
    else:
        indicators, signals, snapshots, exclusions = prepared
    state = {"strategyVersion": engine.CONFIG["strategy"]["version"],
             "initializedSignalDate": str(first.date()), "lastProcessedMarketDate": str(first.date()),
             "accounts": {s: engine._new_account(float(engine.CONFIG["strategy"]["initial_capital_each"]))
                          for s in engine.STRATEGIES}, "candidateSnapshots": deepcopy(snapshots)}
    reports = []
    for date in sessions:
        completed = {s: [] if date == first else engine.execute_pending(
            state["accounts"][s], state["pendingDecisions"][s], date, panel.close) for s in engine.STRATEGIES}
        # Never expose later-month candidate snapshots in an earlier dated report.
        visible_snapshots = {k: v for k, v in state["candidateSnapshots"].items() if pd.Timestamp(k) < date.to_period("M").start_time}
        decisions = {s: engine.make_decision(s, state["accounts"][s], date, panel, indicators, signals, visible_snapshots)
                     for s in engine.STRATEGIES}
        state["pendingDecisions"] = decisions
        state["lastProcessedMarketDate"] = str(date.date())
        quality = {"marketDate": str(date.date()), "universeCount": len(panel.universe),
                   "latestCoverage": 1.0, "missingSymbols": [], "snapshot": panel.snapshot_path.name}
        report_state = {**state, "candidateSnapshots": visible_snapshots}
        report = engine.build_report(date, report_state, completed, decisions, panel, quality)
        report["replay"] = {"requestedStart": str(start.date()), "firstSignalSession": str(first.date()),
                            "kind": "historical-replay", "dataAsOf": audit["lastSession"]}
        report["disclaimer"] = "실제 과거 가격으로 재현한 가상계좌입니다. 당시 실제 실행 기록이 아닙니다."
        reports.append(deepcopy(report))
    return {"schemaVersion": 1, "startDate": str(start.date()), "firstSignalSession": str(first.date()),
            "lastMarketDate": str(sessions[-1].date()), "audit": audit, "candidateExclusions": exclusions,
            "reports": reports}


def generate(prices: pd.DataFrame, catalog: dict, start: pd.Timestamp, end: pd.Timestamp, provenance: dict):
    panel, audit = prepare_panel(prices, catalog, start, end)
    audit["provenance"] = provenance
    audit["evidence"] = catalog.get("evidence", {})
    indicators = engine._indicators(panel)
    signals = engine._signals(panel, indicators)
    snapshots = {}
    sessions = panel.calendar[panel.calendar >= start]
    exclusions = validate_indicators(panel, indicators, signals, sessions, snapshots)
    audit["indicatorValidation"] = "passed"
    prepared = indicators, signals, snapshots, exclusions
    return {str(day.date()): replay(panel, audit, day, prepared=prepared) for day in sessions}


def publish_bundles(bundles: dict, provenance: dict, end: pd.Timestamp, output: Path):
    protected = [engine.DEFAULT_OUTPUT.resolve(), engine.STATIC_OUTPUT.resolve()]
    if output.resolve() in protected:
        raise ValueError("Replay output must not replace production reports")
    release = hashlib.sha256(json.dumps(bundles, sort_keys=True, default=str).encode()).hexdigest()[:20]
    directory = output / release
    directory.mkdir(parents=True, exist_ok=True)
    for start, bundle in bundles.items():
        write_json(bundle, directory / f"{start}.json")
    write_json({"schemaVersion": 1, "releaseId": release, "lastMarketDate": str(end.date()),
                "starts": sorted(bundles), "kind": "historical-replay"}, output / "index.json")
    print(json.dumps({"status": "passed", "starts": len(bundles), "lastMarketDate": str(end.date()),
                      "output": str(output)}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prices", type=Path, nargs="+", required=True, help="Primary followed by audited supplements")
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--start", default="2026-08-31")
    parser.add_argument("--as-of", default="today", help="Korean report date; uses the existing completed-session rule")
    parser.add_argument("--output", type=Path, default=Path("action-output/trading-replays"))
    args = parser.parse_args()
    if args.output.resolve() == engine.DEFAULT_OUTPUT.resolve() or args.output.resolve() == engine.STATIC_OUTPUT.resolve():
        raise ValueError("Replay output must not replace production reports")
    day = pd.Timestamp(korean_today() if args.as_of == "today" else args.as_of)
    if day > pd.Timestamp(korean_today()):
        raise ValueError("Future as-of dates are not allowed")
    end = expected_market_date(day)
    prices, provenance = merge_sources(args.prices)
    provenance["catalogSha256"] = digest(args.catalog)
    provenance["engineSha256"] = digest(Path(engine.__file__))
    provenance["replaySha256"] = digest(Path(__file__))
    provenance["configSha256"] = digest(engine.CONFIG_PATH)
    bundles = generate(prices, json.loads(args.catalog.read_text()), pd.Timestamp(args.start), end, provenance)
    # Validation of every start completes before any published file is written.
    publish_bundles(bundles, provenance, end, args.output)


if __name__ == "__main__":
    main()
