"""Reconcile due report slots and publish validated releases without date guessing."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path

import pandas as pd

from .io_utils import write_json
from .report_store import ReportStore
from .report_time import PORTFOLIO_EVENING_START, calendar_date, due_dates, korean_today, report_context, scheduled_for, utc_now


def recover_market_index(store: ReportStore) -> dict:
    index = store.load("market-reports/index.json") or {"schemaVersion": 2, "reports": []}
    entries = {item["displayDate"]: item for item in index.get("reports", [])}
    # Legacy objects are already published. New staged objects live in a different prefix.
    for key in store.keys("market-reports/"):
        match = re.fullmatch(r"market-reports/(\d{4}-\d{2}-\d{2})\.json", key)
        if not match or match[1] in entries:
            continue
        bundle = store.load(key)
        if not bundle or bundle.get("displayDate") != match[1] or not bundle.get("marketDate"):
            raise ValueError(f"Invalid legacy report: {key}")
        calendar_date(bundle["displayDate"])
        state = bundle.get("summary", {}).get("state", {})
        entries[match[1]] = {"displayDate": match[1], "marketDate": bundle["marketDate"],
                              "generatedAt": bundle.get("generatedAt", ""), "state": state.get("state"),
                              "riskLevel": state.get("risk_level"), "topSector": None, "topTheme": None}
        # Freeze recovered originals so a legacy writer cannot change the new archive.
        store.stage(key, bundle)
    ordered = sorted(entries.values(), key=lambda x: x["displayDate"], reverse=True)
    return {**index, "reports": ordered, "latestDisplayDate": ordered[0]["displayDate"] if ordered else ""}


def publish_morning(store: ReportStore, day: str, source: Path, *, revise: bool = False) -> dict:
    from .publish_market_report_web import build_web_bundle, update_index

    existing = recover_market_index(store)
    known = any(item["displayDate"] == day for item in existing["reports"])
    portfolio_key = f"portfolio-reports/{day}.json"
    previous_portfolio = store.load(portfolio_key)
    evening_portfolio = day >= PORTFOLIO_EVENING_START
    if known and (previous_portfolio or evening_portfolio) and not revise:
        return store.commit(job_date=day, status="published", details={"unchanged": True})
    bundle = build_web_bundle(source)
    portfolio = json.loads((source / "portfolio.json").read_text()) if not evening_portfolio else None
    context = report_context(day)
    if bundle["displayDate"] != day or (portfolio and portfolio["report_date_kst"] != day):
        raise ValueError("Report date differs from fixed job date")
    if bundle["marketDate"] != context["marketSessionDate"] or (portfolio and portfolio["signal_market_date"] != bundle["marketDate"]):
        raise ValueError("Morning reports disagree on the completed market session")
    if portfolio and portfolio.get("stale_preview"):
        raise ValueError("Preview data cannot be published as a normal report")
    if scheduled_for(day) > utc_now():
        raise ValueError("Premature publication")
    bundle["publicationStatus"] = "published"
    bundle["context"] = context
    if portfolio:
        portfolio["context"] = context
        portfolio["publicationStatus"] = "published"
    # A backfill is explicitly a reconstruction, never a claim of original publication.
    if calendar_date(day) < korean_today():
        bundle["reconstructed"] = True
        if portfolio:
            portfolio["reconstructed"] = True
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)
        write_json(existing, target / "index.json")
        index = update_index(target, bundle)
    latest_day = index["latestDisplayDate"]
    for suffix, filename, content_type in (("json", None, "application/json"), ("html", "MARKET_REPORT.html", "text/html"), ("png", "market_dashboard.png", "image/png")):
        store.stage(f"market-reports/{day}.{suffix}", bundle if filename is None else (source / filename).read_bytes(), content_type)
    store.stage("market-reports/index.json", index)
    if portfolio:
        store.stage(portfolio_key, portfolio)
        portfolio_index = store.load("portfolio-reports/index.json") or {"schemaVersion": 1, "reports": []}
        items = {item["reportDate"]: item for item in portfolio_index["reports"]}
        items[day] = {"reportDate": day, "marketDate": portfolio["signal_market_date"], "generatedAt": portfolio["generated_at"]}
        ordered = sorted(items.values(), key=lambda item: item["reportDate"], reverse=True)
        store.stage("portfolio-reports/index.json", {"schemaVersion": 1, "reports": ordered, "latestReportDate": ordered[0]["reportDate"]})
        current_portfolio = store.load("portfolio-reports/latest.json")
        if not current_portfolio or day >= current_portfolio["report_date_kst"]:
            store.stage("portfolio-reports/latest.json", portfolio)
    for path in source.iterdir():
        if path.is_file():
            store.stage(f"report-inputs/morning/{day}/{path.name}", path.read_bytes(), "application/octet-stream")
    return store.commit(job_date=day, details={"context": context, "latestReportDate": latest_day})


def generate_morning(day: str, output: Path):
    from .us_market_report import main as generate
    from .us_daily_portfolio_report import build_device_payload, load_market_data

    generate(["run", "--as-of", day, "--output", str(output)])
    if day < PORTFOLIO_EVENING_START:
        payload = build_device_payload(load_market_data(pd.Timestamp(day)), pd.Timestamp(day))
        write_json(payload, output / "portfolio.json")


def initialize_daily_policy(store: ReportStore, legacy_dates: list[str], now) -> None:
    if store.product != "morning" or store.manifest.get("dailyStartDate"):
        return
    jobs = store.manifest.get("jobs", {})
    successful = [day for day, item in jobs.items() if item["status"] == "published"]
    # Freeze this boundary once: advancing it later would hide new daily failures.
    start = min(successful) if successful else max(legacy_dates, default=korean_today(now).isoformat())
    completed = set(legacy_dates) | set(successful)
    earliest = min([*jobs, *legacy_dates, start])
    recovery = [day for day in due_dates("morning", earliest, completed, now) if day < start]
    store.manifest.update(dailyStartDate=start, recoveryDates=recovery)
    store.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["morning", "trading"])
    parser.add_argument("--as-of")
    parser.add_argument("--revise", action="store_true")
    parser.add_argument("--reset-ledger", action="store_true")
    parser.add_argument("--repair-index", action="store_true")
    parser.add_argument("--recover-history", action="store_true")
    args = parser.parse_args()
    if args.kind == "trading" and (args.repair_index or args.revise or args.recover_history):
        parser.error("Archive recovery and --revise apply only to morning reports")
    if args.recover_history and (args.as_of or args.revise or args.repair_index):
        parser.error("--recover-history cannot be combined with other recovery options")
    if args.kind == "morning" and args.reset_ledger:
        parser.error("--reset-ledger applies only to trading reports")
    store = ReportStore.from_environment(args.kind)
    now = utc_now()
    if args.kind == "morning":
        index = recover_market_index(store)
        store.stage("market-reports/index.json", index)
        if args.repair_index:
            store.commit()
            return
    else:
        index = store.load("trading-test-reports/index.json") or {"reports": []}
    jobs = store.manifest.get("jobs", {})
    completed = {day for day, item in jobs.items() if item["status"] in {"published", "no-new-session"}}
    legacy_dates = [item.get("displayDate", item.get("reportDate")) for item in index.get("reports", [])]
    completed.update(legacy_dates)
    if args.kind == "morning":
        legacy_portfolio = store.load("portfolio-reports/latest.json")
        if legacy_portfolio and not store.load(f"portfolio-reports/{legacy_portfolio['report_date_kst']}.json"):
            store.stage(f"portfolio-reports/{legacy_portfolio['report_date_kst']}.json", legacy_portfolio)
    start = min([*jobs, *legacy_dates] or [korean_today(now).isoformat()])
    if args.as_of:
        target = calendar_date(args.as_of).isoformat()
        if target not in due_dates(args.kind, target, set(), now):
            raise ValueError("Requested date is not an eligible completed publication slot")
        targets = [target]
    else:
        if args.reset_ledger or args.revise:
            raise ValueError("A revision or ledger rebuild requires an explicit --as-of date")
        initialize_daily_policy(store, legacy_dates, now)
        if args.recover_history:
            targets = [day for day in store.manifest.get("recoveryDates", []) if day not in completed]
        else:
            start = store.manifest.get("dailyStartDate", start)
            targets = due_dates(args.kind, start, completed, now)
    pending_recovery = [day for day in store.manifest.get("recoveryDates", []) if day not in completed]
    if pending_recovery and not args.recover_history:
        message = "Historical recovery pending (separate from daily publication): " + ", ".join(pending_recovery)
        print(message)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as file:
                file.write("\n" + message + "\n")
    failures = []
    for day in targets:
        try:
            if args.kind == "morning":
                existing = store.load(f"portfolio-reports/{day}.json")
                if (existing or day >= PORTFOLIO_EVENING_START) and day in legacy_dates and not args.revise:
                    store.commit(job_date=day, details={"unchanged": True})
                    continue
                output = Path("action-output/daily-reports") / day
                generate_morning(day, output)
                publish_morning(store, day, output, revise=args.revise)
            else:
                from .us_market_report import main as refresh
                from .us_ircs_forward_report import run
                refresh(["run", "--as-of", day, "--output", f"action-output/ircs-market-cache/{day}"])
                run(pd.Timestamp(day), upload_r2=True, reset_ledger=args.reset_ledger)
            print(json.dumps({"date": day, "status": "published"}))
        except Exception as error:
            failures.append({"date": day, "type": type(error).__name__, "error": str(error)})
            # Do not commit partially staged objects after a failed generation or publication.
            try:
                failed_store = ReportStore.from_environment(args.kind)
                if failed_store.manifest.get("jobs", {}).get(day, {}).get("status") not in {"published", "no-new-session"}:
                    failed_store.commit(job_date=day, status="failed", details={"error": str(error)})
                store = ReportStore.from_environment(args.kind)
            except Exception as status_error:
                failures[-1]["statusWriteError"] = str(status_error)
                break
    if not targets and store.staged:
        store.commit()
    if failures:
        write_json(failures, Path("action-output/daily-reports/failures.json"))
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as file:
                file.write("\n### Report failures\n```json\n" + json.dumps(failures, indent=2) + "\n```\n")
        raise RuntimeError(json.dumps(failures))


if __name__ == "__main__":
    main()
