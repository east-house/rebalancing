from pathlib import Path
from copy import deepcopy

import numpy as np
import pandas as pd
import pytest

from market_report_pipeline import trading_replay as replay


def bar(day="2026-08-31", price=100.0):
    return {"date": pd.Timestamp(day), "ticker": "AAA", "open": price, "high": price+2,
            "low": price-2, "close": price+1, "volume": 1000.0}


def test_merge_repairs_whole_bars_without_overwriting_primary_or_sources(tmp_path):
    primary = pd.DataFrame([bar(), {**bar("2026-09-01"), "close": np.nan}])
    supplement = pd.DataFrame([bar(price=200), bar("2026-09-01")])
    paths = [tmp_path / "primary.parquet", tmp_path / "secondary.parquet"]
    primary.to_parquet(paths[0]); supplement.to_parquet(paths[1])
    before = [p.read_bytes() for p in paths]
    merged, audit = replay.merge_sources(paths)
    assert list(merged.close) == [101.0, 101.0]
    assert list(merged.sourceIndex) == [0, 1]
    assert len(audit["supplementedRows"]) == 1
    assert [p.read_bytes() for p in paths] == before


def test_bad_bars_and_duplicate_keys_fail(tmp_path):
    assert not replay.valid_bars(pd.DataFrame([{**bar(), "high": 90.0}])).iloc[0]
    assert not replay.valid_bars(pd.DataFrame([{**bar(), "volume": -1}])).iloc[0]
    assert not replay.valid_bars(pd.DataFrame([{**bar(), "close": np.inf}])).iloc[0]
    path = tmp_path / "duplicate.parquet"
    pd.DataFrame([bar(), bar()]).to_parquet(path)
    with pytest.raises(ValueError, match="Duplicate"):
        replay.merge_sources([path])


@pytest.fixture
def inputs(monkeypatch):
    monkeypatch.setattr(replay.engine, "_required_proxy_symbols", lambda: {"IVV"})
    dates = replay.market_calendar(2026).sessions_in_range("2025-06-01", "2026-09-10").tz_localize(None)
    names = [f"S{i:03}" for i in range(490)] + ["IVV"]
    index = pd.MultiIndex.from_product([dates, names], names=["date", "ticker"])
    frame = pd.DataFrame({"open": 100., "high": 102., "low": 98., "close": 101., "volume": 1000.}, index=index).reset_index()
    catalog = {"validFrom": "2026-08-31", "verifiedThrough": "2026-09-10", "sourceRevision": "reviewed",
               "members": [{"ticker": n} for n in names if n != "IVV"]}
    return frame, catalog


def test_warmup_gap_blocks_even_when_forward_period_is_complete(inputs):
    prices, catalog = inputs
    mask = (prices.ticker == "S000") & (prices.date == pd.Timestamp("2026-07-31"))
    prices.loc[mask, "close"] = np.nan
    with pytest.raises(ValueError, match="2026-07-31"):
        replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-10"))


def test_prelisting_absence_requires_evidence_but_postlisting_gap_still_blocks(inputs):
    prices, catalog = inputs
    starts = pd.Timestamp("2026-06-15")
    prices = prices[~((prices.ticker == "S000") & (prices.date < starts))]
    with pytest.raises(ValueError, match="Incomplete"):
        replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-10"))
    catalog["listingHistory"] = {"S000": {"firstTradingSession": "2026-06-15", "source": "issuer notice"}}
    _, audit = replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-10"))
    assert audit["status"] == "passed"
    assert audit["listingHistory"][0]["preTradingSessions"] > 0
    prices = prices[~((prices.ticker == "S000") & (prices.date == starts))]
    with pytest.raises(ValueError, match="2026-06-15"):
        replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-10"))


def test_membership_coverage_and_start_boundaries(inputs):
    prices, catalog = inputs
    with pytest.raises(ValueError, match="Start"):
        replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-28"), pd.Timestamp("2026-09-10"))
    with pytest.raises(ValueError, match="membership"):
        replay.prepare_panel(prices, catalog, pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-11"))


def test_replay_starts_in_cash_then_executes_next_session_and_keeps_accounts_isolated(monkeypatch):
    dates = pd.DatetimeIndex(["2026-09-04", "2026-09-08", "2026-09-09"])
    close = pd.DataFrame({"AAA": [100., 110., 120.], "IVV": [100., 101., 102.]}, index=dates)
    panel = replay.engine.MarketPanel(calendar=dates, close=close, open=close, high=close, low=close, volume=close,
                                     universe=pd.DataFrame({"ticker": ["AAA"]}), snapshot_path=Path("test"))
    def decision(strategy, account, date, *args):
        orders = [{"side": "BUY", "ticker": "AAA", "themeBucket": "Test", "reason": "ircs_entry"}] if strategy == replay.engine.G55_STRATEGY and date == dates[0] else []
        return {"signalDate": str(date.date()), "strategy": strategy, "orders": orders}
    monkeypatch.setattr(replay.engine, "make_decision", decision)
    before = close.copy()
    result = replay.replay(panel, {"lastSession": "2026-09-09"}, dates[0], prepared=({}, {}, {}, {}))
    rows = result["reports"]
    assert rows[0]["accounts"][replay.engine.G55_STRATEGY]["equity"] == 21000
    assert rows[0]["completedActions"][replay.engine.G55_STRATEGY] == []
    bought = rows[1]["completedActions"][replay.engine.G55_STRATEGY][0]
    assert bought["price"] == 110
    assert rows[1]["marketDate"] == "2026-09-08"
    assert rows[1]["reportDate"] == "2026-09-09"
    assert all(r["accounts"][replay.engine.R2_STRATEGY]["equity"] == 21000 for r in rows)
    assert not rows[0]["accounts"][replay.engine.G55_STRATEGY]["positions"]
    pd.testing.assert_frame_equal(close, before)


def test_refresh_refuses_unreviewed_membership_changes(monkeypatch, tmp_path):
    from market_report_pipeline import refresh_trading_replays as refresh
    class Response:
        def __init__(self, value): self.value = value
        def raise_for_status(self): pass
        def json(self): return self.value
    history = {"query": {"pages": {"1": {"revisions": [{"revid": 1370105675}]}}}}
    parsed = {"parse": {"revid": 1370105675, "text": {"*": "<table><tr><th>Symbol</th></tr><tr><td>NEW</td></tr></table>"}}}
    responses = iter([history, parsed])
    monkeypatch.setattr(refresh.requests, "get", lambda *a, **k: Response(next(responses)))
    with pytest.raises(ValueError, match="Membership change"):
        refresh.verify_membership({"members": [{"ticker": "OLD"}], "evidence": {}}, pd.Timestamp("2026-09-11"), tmp_path)


def test_refresh_extends_only_unchanged_verified_membership(monkeypatch, tmp_path):
    from market_report_pipeline import refresh_trading_replays as refresh
    class Response:
        def __init__(self, value): self.value = value
        def raise_for_status(self): pass
        def json(self): return self.value
    responses = iter([
        {"query": {"pages": {"1": {"revisions": [{"revid": 1370105675}]}}}},
        {"parse": {"revid": 1370105675, "text": {"*": "<table><tr><th>Symbol</th></tr><tr><td>AAA</td></tr></table>"}}},
    ])
    monkeypatch.setattr(refresh.requests, "get", lambda *a, **k: Response(next(responses)))
    original = {"members": [{"ticker": "AAA"}], "evidence": {}, "verifiedThrough": "2026-09-10"}
    result = refresh.verify_membership(original, pd.Timestamp("2026-09-11"), tmp_path)
    assert result["verifiedThrough"] == "2026-09-11"
    assert original["verifiedThrough"] == "2026-09-10"
