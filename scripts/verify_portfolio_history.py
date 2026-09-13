"""Verify every public I1 report in a pinned publication release."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_report_pipeline.io_utils import write_json
from market_report_pipeline.repair_portfolio_history import report_days, validate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2026-08-17")
    parser.add_argument("--end", default="2026-09-11")
    parser.add_argument("--base-url", default="https://tm-reports.com")
    parser.add_argument("--output", type=Path, default=Path("action-output/portfolio-history/public-verification.json"))
    args = parser.parse_args()

    def read(path, release=None):
        suffix = f"?release={release}" if release else ""
        request = Request(args.base_url + path + suffix, headers={"cache-control": "no-cache"})
        with urlopen(request, timeout=60) as response:
            actual = response.headers.get("x-report-release")
            if release and actual != release:
                raise ValueError("Public response does not match the pinned release")
            return json.load(response), actual

    index, release = read("/api/portfolio-reports")
    if not release:
        raise ValueError("Missing publication release header")
    days = report_days(args.start, args.end)
    actual = [item["reportDate"] for item in index["reports"] if args.start <= item["reportDate"] <= args.end]
    if sorted(actual) != days:
        raise ValueError("Public index still has missing or duplicate dates")
    reports = [read(f"/api/portfolio-reports/{day}", release)[0] for day in days]
    validate(reports, days)
    if any(not report.get("reconstructed") or not report.get("generated_at") for report in reports):
        raise ValueError("Missing reconstruction provenance")
    if reports[0]["data_snapshot"] != "sp500_20260816.parquet":
        raise ValueError("First report did not use the August 16 universe")
    latest, _ = read("/api/portfolio-reports/latest", release)
    if latest["report_date_kst"] != index["latestReportDate"] or index["latestReportDate"] < days[-1]:
        raise ValueError("Latest report and index disagree")
    audit = {"passed": True, "releaseId": release, "count": len(reports), "missingDates": [],
             "latestReportDate": latest["report_date_kst"],
             "reports": [{"date": item["report_date_kst"], "marketDate": item["signal_market_date"],
                          "executionDate": item["proposed_execution_date"],
                          "selection": [row["ticker"] for row in item["selection"]]} for item in reports]}
    write_json(audit, args.output)
    print(json.dumps(audit))


if __name__ == "__main__":
    main()
