"""Replay the exact input snapshots used by each published forward session."""
from __future__ import annotations

from copy import deepcopy
import hashlib
from io import BytesIO
import math
from pathlib import Path

import pandas as pd

from . import us_ircs_forward_report as engine
from . import trading_replay as replay
from .report_store import encode
from .report_time import utc_now

FIELDS = ("open", "high", "low", "close", "volume", "universe")
INDEX = "trading-test-reports/replay-inputs/index.json"
COMPARISON_FIELDS = ("accounts", "completedActions", "nextActions", "benchmark", "transactionHistory")


def slice_panel(panel, day):
    return engine.MarketPanel(
        calendar=panel.calendar[panel.calendar <= day], universe=panel.universe.copy(),
        snapshot_path=panel.snapshot_path,
        **{name: getattr(panel, name).loc[:day].copy() for name in FIELDS if name != "universe"})


def stage_observation(store, panel, day, quality, *, kind="recorded-run"):
    index = store.load(INDEX)
    if index is None:
        return  # Legacy ledgers are migrated only by the explicit repair command.
    key = str(day.date())
    if key in index["sessions"]:
        raise ValueError(f"Observation is already frozen: {key}")
    visible = slice_panel(panel, day)
    warmup = index.get("audit", {}).get("warmupStart")
    if warmup:
        listed = {row["ticker"]: pd.Timestamp(row["firstTradingSession"])
                  for row in index["audit"].get("listingHistory", [])}
        symbols = set(visible.universe.ticker) | engine._required_proxy_symbols()
        for symbol in symbols:
            if symbol not in visible.close:
                raise ValueError(f"Observation symbol is missing: {symbol}")
            begins = max(pd.Timestamp(warmup), listed.get(symbol, pd.Timestamp(warmup)))
            values = pd.DataFrame({name: getattr(visible, name).loc[begins:day, symbol] for name in FIELDS[:-1]})
            if values.empty or not replay.valid_bars(values).all():
                raise ValueError(f"Observation contains invalid price bars: {day.date()} {symbol}")
    fields = {}
    for name in FIELDS:
        buffer = BytesIO()
        getattr(visible, name).to_parquet(buffer)
        raw = buffer.getvalue()
        digest = hashlib.sha256(raw).hexdigest()
        logical = f"trading-test-reports/replay-inputs/objects/{digest}.parquet"
        store.stage(logical, raw, "application/octet-stream")
        fields[name] = {"path": logical, "sha256": digest}
    index["sessions"][key] = {"fields": fields, "kind": kind, "observedAt": utc_now().isoformat(),
                              "quality": {**quality, "marketDate": key},
                              "snapshot": str(panel.snapshot_path)}
    store.stage(INDEX, index)


def supplement_preserved_history(store, panel, quality):
    """Repair only invalid whole historical bars from a verified observation.

    The incoming calendar and every valid incoming bar are left untouched.
    """
    index = store.load(INDEX)
    if not index or not index.get("sessions"):
        return panel, quality
    last = max(index["sessions"])
    prior = load_observation(store, index["sessions"][last], pd.Timestamp(last))
    result = slice_panel(panel, panel.calendar[-1])
    repaired = 0
    for symbol in panel.close.columns.intersection(prior.close.columns):
        incoming = pd.DataFrame({name: getattr(panel, name)[symbol] for name in FIELDS[:-1]})
        previous = pd.DataFrame({name: getattr(prior, name)[symbol].reindex(panel.calendar) for name in FIELDS[:-1]})
        replace = ~replay.valid_bars(incoming) & replay.valid_bars(previous)
        if replace.any():
            for name in FIELDS[:-1]:
                getattr(result, name).loc[replace, symbol] = previous.loc[replace, name]
            repaired += int(replace.sum())
    return result, {**quality, "preservedHistoryRepairs": repaired}


def load_observation(store, entry, day):
    frames = {}
    for name in FIELDS:
        item = entry["fields"][name]
        raw = store.read(item["path"])
        if raw is None or hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError(f"Input observation integrity failure: {day} {name}")
        frames[name] = pd.read_parquet(BytesIO(raw))
    calendar = pd.DatetimeIndex(frames["close"].index)
    if calendar.empty or calendar[-1] != day or (calendar > day).any():
        raise ValueError(f"Observation does not end on its session: {day}")
    for name in FIELDS[:-1]:
        if not frames[name].index.equals(calendar) or not frames[name].columns.equals(frames["close"].columns):
            raise ValueError(f"Observation matrix mismatch: {name}")
    return engine.MarketPanel(calendar=calendar, snapshot_path=Path(entry["snapshot"]), **frames)


def assert_equal(actual, expected, path="report"):
    if isinstance(actual, dict) and isinstance(expected, dict):
        if actual.keys() != expected.keys():
            raise ValueError(f"Forward/replay keys differ: {path}")
        for key in actual:
            assert_equal(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(actual, list) and isinstance(expected, list):
        if len(actual) != len(expected):
            raise ValueError(f"Forward/replay lengths differ: {path}")
        for i, (left, right) in enumerate(zip(actual, expected)):
            assert_equal(left, right, f"{path}[{i}]")
    elif isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        if not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-8):
            raise ValueError(f"Forward/replay values differ: {path}: {actual} != {expected}")
    elif actual != expected:
        raise ValueError(f"Forward/replay values differ: {path}")


def generate_observed(store):
    index = store.load(INDEX)
    if not index or not index.get("sessions"):
        raise ValueError("No reconciled input observations")
    days = sorted(index["sessions"])
    expected = replay.market_calendar(pd.Timestamp(days[-1]).year).sessions_in_range(days[0], days[-1]).tz_localize(None)
    if days != [str(day.date()) for day in expected]:
        raise ValueError("Missing input observation session")
    accounts, bundles = {}, {}
    for text in days:
        day = pd.Timestamp(text)
        entry = index["sessions"][text]
        panel = load_observation(store, entry, day)
        indicators = engine._indicators(panel)
        signals = engine._signals(panel, indicators)
        accounts[text] = {"strategyVersion": engine.CONFIG["strategy"]["version"],
                          "initializedSignalDate": text, "lastProcessedMarketDate": text,
                          "candidateSnapshots": {}, "accounts": {
                              s: engine._new_account(float(engine.CONFIG["strategy"]["initial_capital_each"]))
                              for s in engine.STRATEGIES}}
        audit = {**deepcopy(index["audit"]), "status": "passed", "missingBars": [],
                 "indicatorValidation": "passed", "firstSignalSession": text,
                 "lastSession": days[-1], "inputMode": "published-session-observations",
                 "observationIndexSha256": hashlib.sha256(encode(index)).hexdigest()}
        bundles[text] = {"schemaVersion": 1, "startDate": text, "firstSignalSession": text,
                         "lastMarketDate": days[-1], "audit": audit, "reports": [], "candidateExclusions": {}}
        for start, state in accounts.items():
            completed = {s: [] if start == text else engine.execute_pending(
                state["accounts"][s], state["pendingDecisions"][s], day, panel.close)
                for s in engine.STRATEGIES}
            exclusions = replay.validate_indicators(panel, indicators, signals, pd.DatetimeIndex([day]), state["candidateSnapshots"])
            bundles[start]["candidateExclusions"].update(exclusions)
            decisions = {s: engine.make_decision(s, state["accounts"][s], day, panel, indicators,
                                               signals, state["candidateSnapshots"]) for s in engine.STRATEGIES}
            state["pendingDecisions"] = decisions
            state["lastProcessedMarketDate"] = text
            report = engine.build_report(day, state, completed, decisions, panel, entry["quality"])
            report["replay"] = {"requestedStart": start, "firstSignalSession": start,
                                "kind": "historical-replay", "dataAsOf": days[-1],
                                "inputMode": "published-session-observations"}
            report["disclaimer"] = "정기 보고서와 같은 거래일별 보존 입력으로 재현한 가상계좌입니다. 실제 주문 기록이 아닙니다."
            bundles[start]["reports"].append(deepcopy(report))
        regular = store.load(f"trading-test-reports/reports/{report['reportDate']}.json")
        if regular is None:
            raise ValueError(f"Missing forward report: {text}")
        first = bundles[days[0]]["reports"][-1]
        for field in COMPARISON_FIELDS:
            assert_equal(first[field], regular[field], f"{text}.{field}")
    return bundles, index
