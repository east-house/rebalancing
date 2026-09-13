"""Read-only checks of published historical recovery and forward/replay equality."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_report_pipeline.io_utils import write_json
from market_report_pipeline.trading_observations import COMPARISON_FIELDS, assert_equal


def verify(base):
    session = requests.Session()
    session.headers.update({"Cache-Control": "no-cache", "User-Agent": "tm-reports-history-verification"})
    def get(path):
        response = session.get(base.rstrip("/") + path, timeout=60)
        response.raise_for_status()
        return response.json()
    morning = get("/api/market-reports/status")
    market_index = get("/api/market-reports")
    recovered = []
    for day, market_day in [("2026-08-18", "2026-08-17"), ("2026-09-03", "2026-09-02")]:
        if morning["jobs"].get(day, {}).get("status") != "published":
            raise ValueError(f"Recovery is not published: {day}")
        report = get(f"/api/market-reports/{day}?release={morning['releaseId']}")
        portfolio = get(f"/api/portfolio-reports/{day}?release={morning['releaseId']}")
        assert report["displayDate"] == portfolio["report_date_kst"] == day
        assert report["marketDate"] == portfolio["signal_market_date"] == market_day
        assert report["reconstructed"] and portfolio["reconstructed"]
        assert report["quality"]["validation"]["passed"] and report["news"]
        dates = pd.to_datetime([row["published_at"] for row in report["news"]])
        assert dates.min() >= pd.Timestamp(market_day) - pd.Timedelta(days=3)
        assert dates.max() <= pd.Timestamp(day) + pd.Timedelta(days=1)
        assert all(row["url"] and row["title"] for row in report["news"])
        image = session.get(base.rstrip("/") + report["dashboardImage"] + f"?release={morning['releaseId']}", timeout=60)
        image.raise_for_status()
        assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
        recovered.append({"reportDate": day, "marketDate": market_day, "newsItems": len(report["news"]),
                          "reconstructed": True, "image": "passed"})
    assert market_index["latestDisplayDate"] >= "2026-09-11"
    index = get("/data/trading-replays/index.json")
    bundle = get(f"/data/trading-replays/{index['releaseId']}/2026-08-31.json")
    if bundle["audit"].get("inputMode") != "published-session-observations":
        raise ValueError("The reconciled replay release is not deployed yet")
    trading = get("/api/trading-test-reports/status")
    compared = []
    for report in bundle["reports"]:
        regular = get(f"/api/trading-test-reports/{report['reportDate']}?release={trading['releaseId']}")
        for field in COMPARISON_FIELDS:
            assert_equal(report[field], regular[field], f"{report['marketDate']}.{field}")
        assert regular.get("reconciliation")
        compared.append({"marketDate": report["marketDate"],
                         "equity": {name: account["equity"] for name, account in regular["accounts"].items()}})
    return {"passed": True, "recovered": recovered, "latestMarketReport": market_index["latestDisplayDate"],
            "morningRelease": morning["releaseId"], "tradingRelease": trading["releaseId"],
            "replayRelease": index["releaseId"], "comparedSessions": len(compared),
            "differences": 0, "compared": compared}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://tm-reports.com")
    parser.add_argument("--output", type=Path, default=Path("action-output/history-repair/public-verification.json"))
    args = parser.parse_args()
    result = verify(args.base_url)
    write_json(result, args.output)
    print(json.dumps(result, ensure_ascii=False))
