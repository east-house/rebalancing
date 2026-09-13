"""Compare production scoring/selection with original functions on identical inputs.

The original path is used only by this explicit audit, never by production.
Monthly scheduling, raw/adjusted price differences and corporate actions are
outside this controlled price-input comparison.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import math
import runpy
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import pandas as pd
from market_report_pipeline import us_daily_portfolio_report as live


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--original-root", type=Path, required=True)
    args = parser.parse_args()
    namespace = {"np": np, "pd": pd, "math": math}
    hashes = {}
    needed = {
        "us_long_only_research.py": ["build_monthly_snapshots"],
        "us_strategy_improvement_research.py": ["_proxy_definition", "_rank_proxy_strength", "_aligned_proxy_close", "_best_proxy_assignments", "_residual_momentum", "build_point_in_time_scores", "select_names"],
        "us_institutional_hybrid_research.py": ["scored_for_candidate"],
    }
    constants = {"SECTOR_PROXIES", "MAX_POSITIONS", "HOLD_RANK", "MAX_NAMES_PER_SECTOR", "MAX_CORRELATION"}
    for filename, names in needed.items():
        path = args.original_root / "src" / filename
        raw = path.read_bytes()
        hashes[filename] = hashlib.sha256(raw).hexdigest()
        tree = ast.parse(raw.decode("utf-8-sig"))
        for node in tree.body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in constants:
                namespace[node.target.id] = ast.literal_eval(node.value)
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in constants:
                        namespace[target.id] = ast.literal_eval(node.value)
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        assert len(functions) == len(names)
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    data = runpy.run_path("tests/market_report_pipeline/test_us_daily_portfolio_report.py")["_market_data"]()
    rng = np.random.default_rng(981)
    data.sector_proxy_close = pd.DataFrame({symbol: 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, len(data.calendar))) for symbol in namespace["SECTOR_PROXIES"].values()}, index=data.calendar)
    close = data.close.assign(IVV=data.benchmark)
    panel = SimpleNamespace(close=close, raw_close=close, dollar_volume=data.dollar_volume.reindex(columns=close.columns), calendar=data.calendar, membership=None)
    namespace["_members_on_date"] = lambda membership, date: set(data.universe.ticker)
    results = []
    for signal in data.calendar[-20::3]:
        # Compare a fixed shared signal date independently of scheduling rules.
        namespace["_month_end_dates"] = lambda calendar, start, end: [signal]
        snapshots = namespace["build_monthly_snapshots"](panel, start=signal, end=signal)
        scores, _ = namespace["build_point_in_time_scores"](panel, snapshots, data.theme_definitions,
            {key: data.theme_proxy_close[key] for key in data.theme_proxy_close},
            {key: data.sector_proxy_close[key] for key in data.sector_proxy_close})
        original = namespace["scored_for_candidate"](panel, scores, {}, SimpleNamespace(score_kind="price", risk_weighted=False, ivv_anchor=True))[signal]
        actual = live.build_daily_ranking(data, signal)
        assert original.ticker.tolist() == actual.ticker.tolist()
        np.testing.assert_allclose(original.score, actual.score, atol=1e-12)
        assert original.sector.tolist() == actual.sector.tolist()
        assert original.theme.tolist() == actual.themes.tolist()
        checks = 0
        for existing in [[], ["IVV", "H"], ["IVV", "A", "B", "C", "D"], actual.ticker.tolist()[-5:]]:
            expected, trace = namespace["select_names"](original, close, signal, existing, max_per_theme=None)
            assert live.select_portfolio(actual, data, signal, tuple(existing)) == expected
            checks += 1
        results.append({"signal": str(signal.date()), "ranking_count": len(actual), "selection_cases": checks})
    output = {"passed": True, "source_sha256": hashes, "results": results,
        "scope": "Identical synthetic price inputs: score, rank, sector assignment, retained-name/sector/correlation selection. Not execution/calendar/corporate-action equivalence."}
    path = Path("action-output/i1-source-parity.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
