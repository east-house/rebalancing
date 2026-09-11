"""Verify every published replay and optionally test future-price independence."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_report_pipeline import trading_replay as replay


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-6), (actual, expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("public/data/trading-replays"))
    parser.add_argument("--inputs", type=Path)
    args = parser.parse_args()
    index = json.loads((args.root / "index.json").read_text())
    total = 0
    for start in index["starts"]:
        bundle = json.loads((args.root / index["releaseId"] / f"{start}.json").read_text())
        rows = bundle["reports"]
        assert bundle["audit"]["missingBars"] == []
        assert bundle["audit"]["indicatorValidation"] == "passed"
        expected = replay.market_calendar(pd.Timestamp(index["lastMarketDate"]).year).sessions_in_range(start, index["lastMarketDate"]).tz_localize(None)
        assert [r["marketDate"] for r in rows] == [str(d.date()) for d in expected]
        for i, report in enumerate(rows):
            assert report["reportDate"] == str((expected[i] + pd.offsets.Day(1)).date())
            for strategy in replay.engine.STRATEGIES:
                account = report["accounts"][strategy]
                close(account["marketValue"], sum(p["marketValue"] for p in account["positions"]))
                close(account["equity"], account["cash"] + account["marketValue"])
                close(account["totalReturn"], account["equity"] / 21000 - 1)
                close(account["cash"], 21000 + sum(
                    -(t["notional"] + t["fee"]) if t["side"] == "BUY" else t["notional"] - t["fee"] if t["side"] == "SELL" else 0
                    for t in report["transactionHistory"][strategy]))
                if not i:
                    close(account["equity"], 21000)
                    assert not report["transactionHistory"][strategy]
                for transaction in report["transactionHistory"][strategy]:
                    assert start <= transaction["signalDate"] < transaction["executionDate"] <= report["marketDate"]
                for action in report["completedActions"][strategy]:
                    if action["side"] != "HOLD":
                        assert any(action["side"] == o["side"] and action["ticker"] == o["ticker"] for o in rows[i-1]["nextActions"][strategy]["orders"])
                assert report["nextActions"][strategy]["signalDate"] == report["marketDate"]
            total += 1
    lookahead = None
    if args.inputs:
        prices, provenance = replay.merge_sources([args.inputs / n for n in ["primary.parquet", "cache-supplement.parquet", "fisv-supplement.parquet"]])
        catalog = json.loads((args.inputs / "catalog.json").read_text())
        start = pd.Timestamp(index["starts"][0]); end = pd.Timestamp(index["lastMarketDate"])
        panel, audit = replay.prepare_panel(prices, catalog, start, end)
        original = replay.replay(panel, audit, start)
        modified = deepcopy(panel)
        cutoff = pd.Timestamp("2026-09-04")
        for field in ["open", "high", "low", "close"]:
            getattr(modified, field).loc[lambda f: f.index > cutoff] *= 1.07
        other = replay.replay(modified, audit, start)
        for before, after in zip(original["reports"], other["reports"]):
            if pd.Timestamp(before["marketDate"]) > cutoff:
                break
            for key in ["accounts", "completedActions", "nextActions", "benchmark", "transactionHistory"]:
                assert before[key] == after[key], (before["marketDate"], key)
        for excluded in original["candidateExclusions"].values():
            assert {"FDXF", "HONA", "Q"}.issubset(excluded)
        lookahead = "passed"
    print(json.dumps({"starts":len(index["starts"]),"datedReports":total,"accountReports":total*2,
                      "balances":"passed","sessionOrder":"passed","futurePriceIndependence":lookahead}))


if __name__ == "__main__":
    main()
