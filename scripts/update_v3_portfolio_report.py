"""Generate the public v3 report through the canonical stock_strategy project."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STOCK_PROJECT = PROJECT_ROOT.parent / "stock_strategy" / "stock_rank_prediction"
DEFAULT_OUTPUT = PROJECT_ROOT / "public" / "data" / "portfolio-reports" / "latest.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", default="today")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--stock-project", type=Path, default=Path(os.environ.get("STOCK_STRATEGY_PROJECT", DEFAULT_STOCK_PROJECT)))
    parser.add_argument("--python", dest="python_executable", default=os.environ.get("STOCK_STRATEGY_PYTHON", sys.executable))
    args = parser.parse_args()

    stock_project = args.stock_project.resolve()
    if not (stock_project / "src" / "us_v3_portfolio_report.py").exists():
        raise FileNotFoundError("Set STOCK_STRATEGY_PROJECT to the stock_rank_prediction project containing v3.")
    target = args.output.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [args.python_executable, "-m", "src.us_v3_portfolio_report", "--as-of", args.as_of, "--output", str(target)]
    subprocess.run(command, cwd=stock_project, check=True)

    payload = json.loads(target.read_text(encoding="utf-8"))
    tickers = [item["ticker"] for item in payload["selection"]]
    if payload["strategy"]["id"] != "v3" or len(tickers) != 5 or tickers[0] != "IVV":
        raise RuntimeError("Invalid v3 export: expected IVV plus four selected stocks")
    if abs(sum(float(item["weight"]) for item in payload["selection"]) - 1.0) > 1e-12:
        raise RuntimeError("Invalid v3 export: target weights must total 100%")
    print(json.dumps({"strategy": "v3", "selection": tickers, "sha256": sha256(target), "output": str(target)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
