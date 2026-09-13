"""Reconstruct a complete I1 archive and atomically publish a preserved revision."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path

import pandas as pd

from .io_utils import write_json, atomic_write_parquet
from .report_store import ReportStore
from .report_time import calendar_date, due_dates, report_context, next_execution_date, utc_now
from .support import PROJECT_ROOT, STOCK_CACHE, safe_symbol
from .us_daily_portfolio_report import build_device_payload, load_market_data

SNAPSHOTS = PROJECT_ROOT / "data/reference/portfolio-universe"


def report_days(start: str, end: str | None = None, now=None) -> list[str]:
    days = due_dates("morning", start, set(), now or utc_now())
    if end is not None:
        end = calendar_date(end).isoformat()
        days = [day for day in days if day <= end]
    if not days:
        raise ValueError("No completed Korean weekday report slots in requested range")
    return days


def snapshot_for(day: str, directory: Path = SNAPSHOTS) -> Path:
    # Use preserved dated snapshots, never fetch today's constituents as a past snapshot.
    cutoff = pd.Timestamp(day) - pd.Timedelta(days=1)
    paths = sorted(path for path in directory.glob("sp500_*.parquet")
                   if pd.Timestamp(path.stem.split("_")[-1]) <= cutoff)
    if not paths:
        raise ValueError(f"No preserved universe known before {day}")
    return paths[-1]


def validate(reports: list[dict], days: list[str]) -> None:
    if [item["report_date_kst"] for item in reports] != days:
        raise ValueError("Portfolio archive has missing, duplicate or unordered dates")
    for item in reports:
        day = item["report_date_kst"]
        context = report_context(day)
        if item["signal_market_date"] != context["marketSessionDate"]:
            raise ValueError(f"Incorrect US session for {day}")
        if item["proposed_execution_date"] != str(next_execution_date(day).date()):
            raise ValueError(f"Incorrect execution session for {day}")
        if item.get("stale_preview") or item["strategy"]["id"] != "i1_core_satellite":
            raise ValueError(f"Invalid strategy or stale data for {day}")
        selection = item["selection"]
        names = [row["ticker"] for row in selection]
        if not 1 <= len(names) <= 5 or names[0] != "IVV" or len(set(names)) != len(names):
            raise ValueError(f"Invalid I1 selection for {day}")
        if any(abs(row["weight"] - 1 / len(names)) > 1e-9 for row in selection):
            raise ValueError(f"Invalid I1 weights for {day}")
        if item["policy"]["stop_loss"] is not None or item["policy"]["trailing_stop"] is not None:
            raise ValueError(f"I1 stops must be disabled for {day}")


def fill_price_gaps(symbols: set[str], days: list[str], output: Path) -> list[dict]:
    """Fill missing historical bars even when a cache already has its latest close."""
    from .support import _download_yahoo_frame
    sessions = sorted({pd.Timestamp(report_context(day)["marketSessionDate"]) for day in days})

    def fill(symbol):
        path = STOCK_CACHE / f"{safe_symbol(symbol)}.parquet"
        old = pd.read_parquet(path) if path.exists() else pd.DataFrame()
        existing = set(pd.to_datetime(old["date"])) if not old.empty else set()
        missing = sorted(set(sessions) - existing)
        if not missing:
            return {"symbol": symbol, "missingBefore": [], "missingAfter": []}
        update = _download_yahoo_frame(symbol, missing[0], sessions[-1] + pd.Timedelta(days=1),
                                       timeout=20, max_retries=4)
        update = update.loc[pd.to_datetime(update["date"]).le(sessions[-1])]
        # Keep existing cached observations; append only missing dates.
        combined = pd.concat([old, update], ignore_index=True).drop_duplicates("date", keep="first").sort_values("date")
        atomic_write_parquet(combined, path)
        remaining = sorted(set(sessions) - set(pd.to_datetime(combined["date"])))
        return {"symbol": symbol, "missingBefore": [str(day.date()) for day in missing],
                "missingAfter": [str(day.date()) for day in remaining]}

    with ThreadPoolExecutor(max_workers=4) as executor:
        audit = list(executor.map(fill, sorted(symbols)))
    write_json(audit, output / "historical-price-gaps.json")
    return audit


def prepare(days: list[str], output: Path, *, refresh_prices: bool = False) -> list[dict]:
    output.mkdir(parents=True, exist_ok=True)
    paths = {day: snapshot_for(day) for day in days}
    if refresh_prices:
        from .us_market_report import MarketRunSettings, collect_context_prices, load_config
        config_path = PROJECT_ROOT / "config/market-report.yaml"
        config = load_config(config_path)
        symbols = {"IVV", "^GSPC"}
        for path in set(paths.values()):
            symbols.update(pd.read_parquet(path)["ticker"].astype(str))
        symbols.update(config["sector_proxies"].values())
        symbols.update(item["proxy"] for item in config["themes"].values())
        settings = MarketRunSettings(pd.Timestamp(days[-1]), pd.Timestamp(config["data"]["history_start"]),
                                     output, config_path)
        collect_context_prices(sorted(symbols), settings, config)
        gaps = fill_price_gaps(symbols, days, output)
        required = {"IVV", *config["sector_proxies"].values(),
                    *(item["proxy"] for item in config["themes"].values())}
        if any(item["missingAfter"] for item in gaps if item["symbol"] in required):
            raise ValueError("Unresolved historical benchmark/proxy gaps")
    reports = []
    for day in days:
        path = paths[day]
        cutoff = pd.Timestamp(day) - pd.Timedelta(days=1)
        data = load_market_data(cutoff, universe_snapshot=path)
        session = pd.Timestamp(report_context(day)["marketSessionDate"])
        if session not in data.close.index or int(data.close.loc[session].notna().sum()) < 490:
            raise ValueError(f"Insufficient historical stock coverage for {day}")
        for proxies in (data.theme_proxy_close, data.sector_proxy_close):
            if session not in proxies.index or proxies.loc[session].isna().any():
                raise ValueError(f"Missing historical proxy prices for {day}")
        report = build_device_payload(data, pd.Timestamp(day))
        report.update(context=report_context(day), reconstructed=True, publicationStatus="published")
        report["reconstruction"] = {
            "kind": "i1-historical-reconstruction", "universeSnapshot": path.name,
            "universeSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "informationThroughKst": str(cutoff.date()),
            "priceBasis": "cached historical adjusted closes; not original publication observations",
        }
        reports.append(report)
        write_json(report, output / f"{day}.json")
        print(json.dumps({"date": day, "marketDate": report["signal_market_date"],
                          "selection": [item["ticker"] for item in report["selection"]]}), flush=True)
    validate(reports, days)
    write_json({"passed": True, "days": days, "count": len(days),
                "firstMarketDate": reports[0]["signal_market_date"],
                "lastMarketDate": reports[-1]["signal_market_date"]}, output / "verification.json")
    return reports


def publish(reports: list[dict], *, store=None) -> dict:
    validate(reports, report_days(reports[0]["report_date_kst"], reports[-1]["report_date_kst"]))
    target = store if store is not None else ReportStore.from_environment("morning")
    previous = target.manifest.get("releaseId", "legacy")
    target.stage(f"portfolio-reports/revisions/{previous}.json", target.manifest)
    index = target.load("portfolio-reports/index.json") or {"schemaVersion": 1, "reports": []}
    entries = {item["reportDate"]: item for item in index["reports"]}
    for report in reports:
        day = report["report_date_kst"]
        logical = f"portfolio-reports/{day}.json"
        old = target.read(logical)
        if old is not None:
            target.stage(f"portfolio-reports/archive/{previous}/{day}.json", old)
        target.stage(logical, report)
        entries[day] = {"reportDate": day, "marketDate": report["signal_market_date"],
                        "generatedAt": report["generated_at"]}
    ordered = sorted(entries.values(), key=lambda item: item["reportDate"], reverse=True)
    latest = ordered[0]["reportDate"]
    target.stage("portfolio-reports/index.json", {"schemaVersion": 1, "reports": ordered, "latestReportDate": latest})
    latest_report = target.load(f"portfolio-reports/{latest}.json")
    if latest_report is None:
        raise ValueError("Latest indexed portfolio report is missing")
    target.stage("portfolio-reports/latest.json", latest_report)
    # This repairs only portfolio objects; market reports and their job states stay intact.
    return target.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2026-08-17")
    parser.add_argument("--end")
    parser.add_argument("--output", type=Path, default=Path("action-output/portfolio-history"))
    parser.add_argument("--refresh-prices", action="store_true")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    reports = prepare(report_days(args.start, args.end), args.output, refresh_prices=args.refresh_prices)
    if args.publish:
        result = publish(reports)
        write_json({"releaseId": result["releaseId"]}, args.output / "publication.json")


if __name__ == "__main__":
    main()
