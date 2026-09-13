from copy import deepcopy
from pathlib import Path

import pandas as pd
import pytest

from market_report_pipeline import trading_observations as observations
from market_report_pipeline import us_ircs_forward_report as engine
from market_report_pipeline.repair_trading_history import MemoryStore, publish


@pytest.fixture
def recorded(tmp_path, monkeypatch):
    days = pd.DatetimeIndex(["2026-09-04", "2026-09-08", "2026-09-09"])
    close = pd.DataFrame({"AAA": [100., 110., 120.], "IVV": [100., 101., 102.]}, index=days)
    panel = engine.MarketPanel(calendar=days, close=close, open=close, high=close, low=close, volume=close,
                               universe=pd.DataFrame({"ticker": ["AAA"]}), snapshot_path=Path("test"))
    seed = {"strategyVersion": engine.CONFIG["strategy"]["version"], "initializedSignalDate": str(days[0].date()),
            "lastProcessedMarketDate": str(days[0].date()), "accounts": {s: engine._new_account(21000) for s in engine.STRATEGIES},
            "pendingDecisions": {}, "candidateSnapshots": {}}
    monkeypatch.setattr(engine, "load_seed_state", lambda: deepcopy(seed))
    monkeypatch.setattr(engine, "_indicators", lambda _: {})
    monkeypatch.setattr(engine, "_signals", lambda *_: {})
    monkeypatch.setattr(observations.replay, "validate_indicators", lambda *_: {})
    def decision(strategy, account, day, panel, *_):
        orders = [{"side": "BUY", "ticker": "AAA", "themeBucket": "Test", "reason": "ircs_entry"}] if day == days[0] and panel.close.at[day, "AAA"] < 200 else []
        return {"signalDate": str(day.date()), "strategy": strategy, "orders": orders, "marketGate": {"open": True}}
    monkeypatch.setattr(engine, "make_decision", decision)
    store = MemoryStore()
    store.stage(observations.INDEX, {"schemaVersion": 1, "audit": {"provenance": {}}, "sessions": {}})
    originals = []
    for i, day in enumerate(days):
        incoming = observations.slice_panel(panel, day)
        if i:
            # Later provider data changes an earlier value: never replay it as the old observation.
            incoming.close.loc[days[0], "AAA"] = 900.
        quality = {"marketDate": str(day.date())}
        result = engine.run(day + pd.offsets.Day(1), tmp_path, market_input=(incoming, quality))
        report = result["reports"][-1]
        originals.append(report)
        store.stage(f"trading-test-reports/reports/{report['reportDate']}.json", report)
        observations.stage_observation(store, incoming, day, quality)
    return store, result["state"], originals, panel


def test_replay_uses_each_original_observation_and_matches_sequential_forward(recorded):
    store, _, originals, _ = recorded
    before = dict(store.objects)
    bundles, index = observations.generate_observed(store)
    assert len(bundles) == 3
    for actual, expected in zip(bundles["2026-09-04"]["reports"], originals):
        for field in observations.COMPARISON_FIELDS:
            observations.assert_equal(actual[field], expected[field])
    assert bundles["2026-09-04"]["reports"][0]["nextActions"][engine.G55_STRATEGY]["orders"]
    assert bundles["2026-09-08"]["reports"][0]["accounts"][engine.G55_STRATEGY]["equity"] == 21000
    assert store.objects == before


def test_observation_cannot_be_overwritten_or_loaded_after_corruption(recorded):
    store, _, _, panel = recorded
    day = panel.calendar[0]
    with pytest.raises(ValueError, match="already frozen"):
        observations.stage_observation(store, panel, day, {})
    index = store.load(observations.INDEX)
    key = index["sessions"][str(day.date())]["fields"]["close"]["path"]
    store.objects[key] = b"corrupt"
    with pytest.raises(ValueError, match="integrity"):
        observations.generate_observed(store)


def test_missing_session_or_mismatching_forward_result_blocks_publication(recorded):
    store, _, originals, _ = recorded
    key = f"trading-test-reports/reports/{originals[-1]['reportDate']}.json"
    report = store.load(key)
    report["accounts"][engine.G55_STRATEGY]["equity"] += 1
    store.stage(key, report)
    with pytest.raises(ValueError, match="values differ"):
        observations.generate_observed(store)
    index = store.load(observations.INDEX)
    del index["sessions"]["2026-09-08"]
    store.stage(observations.INDEX, index)
    with pytest.raises(ValueError, match="Missing input"):
        observations.generate_observed(store)


class TargetStore(MemoryStore):
    def __init__(self):
        super().__init__()
        self.manifest = {"releaseId": "old-release", "objects": {"original": "preserved"}}
        self.commits = 0
    def commit(self, **kwargs):
        self.commits += 1
        self.manifest = {**self.manifest, "releaseId": "new-release"}
        return self.manifest


def test_explicit_revision_preserves_originals_and_is_idempotent(recorded):
    source, state, reports, _ = recorded
    target = TargetStore()
    old = {**state, "legacy": True}
    target.stage("trading-test-reports/state/latest.json", old)
    original_manifest = deepcopy(target.manifest)
    prepared = source, state, reports, {}
    publish(prepared, pd.Timestamp("2026-09-10"), store=target)
    assert target.load("trading-test-reports/revisions/old-release.json") == original_manifest
    assert any(target.load(key) == old for key in target.objects if "/state/archive/" in key)
    assert target.load("trading-test-reports/latest.json")["reconciliation"]["previousReleaseId"] == "old-release"
    publish(prepared, pd.Timestamp("2026-09-10"), store=target)
    assert target.commits == 1


def test_revision_never_moves_ledger_backwards(recorded):
    source, state, reports, _ = recorded
    target = TargetStore()
    target.stage("trading-test-reports/state/latest.json", {**state, "lastProcessedMarketDate": "2026-09-10"})
    with pytest.raises(ValueError, match="backwards"):
        publish((source, state, reports, {}), pd.Timestamp("2026-09-10"), store=target)
    assert target.commits == 0


def test_only_invalid_bars_are_repaired_without_changing_calendar(recorded):
    store, _, _, panel = recorded
    incoming = observations.slice_panel(panel, panel.calendar[-1])
    day = panel.calendar[1]
    incoming.close.loc[day, "AAA"] = float("nan")
    # A later valid provider correction must remain the input for this new run.
    incoming.close.loc[panel.calendar[0], "IVV"] = 95.
    incoming.low.loc[panel.calendar[0], "IVV"] = 95.
    repaired, quality = observations.supplement_preserved_history(store, incoming, {})
    assert repaired.calendar.equals(incoming.calendar)
    assert repaired.close.loc[day, "AAA"] == 110.
    assert repaired.close.loc[panel.calendar[0], "IVV"] == 95.
    assert quality["preservedHistoryRepairs"] == 1
    assert pd.isna(incoming.close.loc[day, "AAA"])
