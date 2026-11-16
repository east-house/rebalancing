"""Publish the independent 19:00 KST weekday I1 report, preserving its archive."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import pandas as pd
from .io_utils import write_json
from .report_store import ReportStore
from .report_time import PORTFOLIO_EVENING_START, calendar_date, due_dates, korean_today, market_calendar, next_execution_date, report_context, scheduled_for, utc_now


def initialize_archive(store: ReportStore, morning: ReportStore) -> None:
    if store.manifest.get("dailyStartDate"):
        return
    index = morning.load("portfolio-reports/index.json") or {"schemaVersion": 1, "reports": []}
    for item in index["reports"]:
        key = f"portfolio-reports/{item['reportDate']}.json"
        payload = morning.load(key)
        if not payload or payload.get("report_date_kst") != item["reportDate"]:
            raise ValueError(f"Cannot preserve incomplete portfolio archive: {key}")
        store.stage(key, payload)
    store.stage("portfolio-reports/index.json", index)
    if index["reports"]:
        latest = max(item["reportDate"] for item in index["reports"])
        store.stage("portfolio-reports/latest.json", store.load(f"portfolio-reports/{latest}.json"))
    store.manifest["dailyStartDate"] = PORTFOLIO_EVENING_START
    store.commit()


def publish_portfolio(store: ReportStore, day: str, payload: dict, inputs: dict | None = None,
                      core_quote: dict | None = None) -> None:
    if day < PORTFOLIO_EVENING_START or day not in due_dates("portfolio", day, set()):
        raise ValueError("Portfolio report is not due yet")
    context = report_context(day, "portfolio")
    if payload.get("report_date_kst") != day or payload.get("signal_market_date") != context["marketSessionDate"] or payload.get("stale_preview"):
        raise ValueError("Portfolio data cutoff or report date mismatch")
    execution = next_execution_date(day)
    if payload.get("proposed_execution_date") != str(execution.date()):
        raise ValueError("Portfolio execution date mismatch")
    context["executionSessionDate"] = str(execution.date())
    context["executionCloseAt"] = market_calendar(execution.year).session_close(execution).isoformat()
    payload = {**payload, "report_time_kst": "19:00", "context": context, "publicationStatus": "published"}
    if calendar_date(day) < korean_today():
        payload["reconstructed"] = True
    key = f"portfolio-reports/{day}.json"
    if store.load(key):
        raise ValueError("Published portfolio reports are immutable; use an explicit preserved revision")
    index = store.load("portfolio-reports/index.json") or {"schemaVersion": 1, "reports": []}
    entries = {item["reportDate"]: item for item in index["reports"]}
    entries[day] = {"reportDate": day, "marketDate": payload["signal_market_date"], "generatedAt": payload["generated_at"]}
    ordered = sorted(entries.values(), key=lambda item: item["reportDate"], reverse=True)
    store.stage(key, payload)
    if inputs is not None:
        # Supplementary I2/S1 inputs; the I1 report object itself is unchanged.
        from .portfolio_strategy_inputs import stage_inputs
        stage_inputs(store, day, inputs)
    if core_quote is not None:
        # Account core ETF (SPYM) close for integer-share browser accounts; separate object.
        from .portfolio_strategy_inputs import stage_core_quote
        stage_core_quote(store, day, core_quote)
    store.stage("portfolio-reports/index.json", {"schemaVersion": 1, "reports": ordered, "latestReportDate": ordered[0]["reportDate"]})
    if day == ordered[0]["reportDate"]:
        store.stage("portfolio-reports/latest.json", payload)
    store.commit(job_date=day, details={"context": context, "generatedAt": payload["generated_at"], "scheduledFor": scheduled_for(day, "portfolio").isoformat()})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of")
    parser.add_argument("--initialize-only", action="store_true")
    args = parser.parse_args()
    store = ReportStore.from_environment("portfolio")
    if not store.manifest.get("dailyStartDate"):
        initialize_archive(store, ReportStore.from_environment("morning"))
    if args.initialize_only:
        print(json.dumps({"status": "initialized", "dailyStartDate": store.manifest["dailyStartDate"]}))
        return
    completed = {day for day, item in store.manifest.get("jobs", {}).items() if item["status"] == "published"}
    # Preserve past publications imported during the split as well.
    completed.update(item["reportDate"] for item in (store.load("portfolio-reports/index.json") or {}).get("reports", []))
    targets = due_dates("portfolio", PORTFOLIO_EVENING_START, completed)
    if args.as_of:
        day = calendar_date(args.as_of).isoformat()
        if day in completed:
            print(json.dumps({"date": day, "status": "already-published"}))
            return
        if day not in targets:
            raise ValueError("Requested portfolio date is not due")
        targets = [day]
    failures = []
    for day in targets:
        try:
            context = report_context(day, "portfolio")
            store.commit(job_date=day, status="running", details={"context": context, "scheduledFor": scheduled_for(day, "portfolio").isoformat()})
            from .us_market_report import main as collect
            from .us_daily_portfolio_report import build_device_payload, load_market_data
            output = Path("action-output/portfolio-evening") / day
            collect(["run", "--as-of", day, "--output", str(output)])
            data = load_market_data(pd.Timestamp(day))
            payload = build_device_payload(data, pd.Timestamp(day))
            write_json(payload, output / "portfolio.json")
            inputs = None
            try:
                from .portfolio_strategy_inputs import inputs_from_market_data
                inputs = inputs_from_market_data(data, payload)
                write_json(inputs, output / "strategy-inputs.json")
            except Exception as input_error:  # I1 publication must not depend on the I2/S1 inputs
                write_json({"error": str(input_error)}, output / "strategy-inputs-error.json")
                print(json.dumps({"date": day, "strategyInputs": "failed", "error": str(input_error)}))
            core_quote = None
            try:
                from .portfolio_strategy_inputs import core_quote_for_payload
                core_quote = core_quote_for_payload(payload)
                write_json(core_quote, output / "core-quote.json")
            except Exception as core_error:  # I1 publication must not depend on the account core ETF quote
                write_json({"error": str(core_error)}, output / "core-quote-error.json")
                print(json.dumps({"date": day, "coreQuote": "failed", "error": str(core_error)}))
            publish_portfolio(store, day, payload, inputs, core_quote)
            print(json.dumps({"date": day, "status": "published", "signalDate": payload["signal_market_date"], "executionDate": payload["proposed_execution_date"]}))
        except Exception as error:
            # Discard staged partial outputs and leave the last complete publication readable.
            store = ReportStore.from_environment("portfolio")
            if store.manifest.get("jobs", {}).get(day, {}).get("status") != "published":
                store.commit(job_date=day, status="failed", details={"error": str(error), "context": report_context(day, "portfolio")})
            failures.append({"date": day, "error": str(error)})
    if failures:
        raise RuntimeError(json.dumps(failures))


if __name__ == "__main__":
    main()
