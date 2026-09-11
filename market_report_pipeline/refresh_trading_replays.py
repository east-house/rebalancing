"""Refresh isolated replay files after a successful production publication."""
from __future__ import annotations

import argparse
from io import StringIO
import json
from pathlib import Path

import pandas as pd
import requests

from . import trading_replay as replay
from .io_utils import write_json
from .support import STOCK_CACHE, _download_yahoo_frame, safe_symbol

WIKI_API = "https://en.wikipedia.org/w/api.php"


def verify_membership(catalog: dict, end: pd.Timestamp, evidence: Path) -> dict:
    """Extend only demonstrably unchanged membership; never backdate today's list."""
    expected = {row["ticker"] for row in catalog["members"]}
    headers = {"User-Agent": "tm-reports-replay-audit/1.0 (historical membership verification)"}
    params = {"action": "query", "prop": "revisions", "titles": "List of S&P 500 companies",
              "rvstart": f"{end.date()}T23:59:59Z", "rvend": "2026-08-19T03:43:37Z",
              "rvlimit": "max", "rvprop": "ids|timestamp", "format": "json"}
    revisions = []
    while True:
        response = requests.get(WIKI_API, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        payload = response.json()
        if "query" not in payload:
            raise ValueError("Membership revision history is unavailable")
        for page in payload["query"]["pages"].values():
            revisions.extend(page.get("revisions", []))
        if "continue" not in payload:
            break
        params.update(payload["continue"])
    if not any(r["revid"] == 1370105675 for r in revisions):
        raise ValueError("Membership history does not reach the reviewed baseline")
    evidence.mkdir(parents=True, exist_ok=True)
    write_json(revisions, evidence / "revisions.json")
    for revision in revisions:
        response = requests.get(WIKI_API, params={"action": "parse", "oldid": revision["revid"],
                                "prop": "text|revid", "format": "json"}, headers=headers, timeout=30)
        response.raise_for_status()
        payload = response.json()
        if payload.get("parse", {}).get("revid") != revision["revid"]:
            raise ValueError("Membership revision response mismatch")
        write_json(payload, evidence / f"{revision['revid']}.json")
        table = pd.read_html(StringIO(payload["parse"]["text"]["*"]))[0]
        actual = set(table.Symbol)
        if actual != expected or len(table) != len(expected):
            raise ValueError(f"Membership change requires reviewed effective dates: revision={revision['revid']}, added={sorted(actual-expected)}, removed={sorted(expected-actual)}")
    return {**catalog, "verifiedThrough": str(end.date()),
            "evidence": {**catalog["evidence"], "checkedRevisions": revisions}}


def refresh(as_of: pd.Timestamp, output: Path, work: Path):
    end = replay.expected_market_date(as_of)
    if as_of > pd.Timestamp(replay.korean_today()):
        raise ValueError("Future as-of date")
    baseline = Path(__file__).resolve().parents[1] / "config/trading-replay-catalog.json"
    catalog = verify_membership(json.loads(baseline.read_text()), end, work / "membership")
    symbols = sorted({r["ticker"] for r in catalog["members"]} | replay.engine._required_proxy_symbols())
    calendar = replay.market_calendar(end.year).sessions_in_range("2025-08-28", end).tz_localize(None)
    frames, downloads = [], []
    for number, symbol in enumerate(symbols, 1):
        path = STOCK_CACHE / f"{safe_symbol(symbol)}.parquet"
        cached = pd.read_parquet(path) if path.exists() else pd.DataFrame(columns=["date", "ticker", *replay.FIELDS])
        cached["date"] = pd.to_datetime(cached.date)
        frames.append(cached)
        begins = catalog.get("listingHistory", {}).get(symbol, {}).get("firstTradingSession", "2025-08-28")
        required = calendar[calendar >= pd.Timestamp(begins)]
        valid = cached.loc[replay.valid_bars(cached)]
        missing = required.difference(pd.DatetimeIndex(valid.date))
        # The reviewed alternate feed supplies this one missing Yahoo bar below.
        if symbol == "FISV":
            missing = missing[missing != pd.Timestamp("2025-11-12")]
        if not missing.empty:
            downloaded = _download_yahoo_frame(symbol, missing.min(), missing.max() + pd.offsets.Day(1),
                                               timeout=30, max_retries=4, diagnostics_dir=work / "http")
            downloads.append(downloaded)
        if number % 25 == 0 or number == len(symbols):
            print(json.dumps({"checkedSymbols": number, "totalSymbols": len(symbols), "downloadedSymbols": len(downloads)}), flush=True)
    work.mkdir(parents=True, exist_ok=True)
    primary = work / "cache.parquet"
    pd.concat(frames, ignore_index=True).to_parquet(primary, index=False)
    paths = [primary]
    if downloads:
        path = work / "downloaded.parquet"
        pd.concat(downloads, ignore_index=True).to_parquet(path, index=False)
        paths.append(path)
    # An intervening adjustment invalidates the reviewed unadjusted FISV exception.
    response = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/FISV", params={
        "period1": int(pd.Timestamp("2025-11-12", tz="UTC").timestamp()),
        "period2": int((end.tz_localize("UTC") + pd.offsets.Day(1)).timestamp()),
        "interval": "1d", "events": "div,splits", "includeAdjustedClose": "true"},
        headers={"User-Agent": "tm-reports-replay-audit/1.0"}, timeout=30)
    response.raise_for_status()
    payload = response.json()
    write_json(payload, work / "fisv-adjustments.json")
    if payload["chart"]["result"][0].get("events"):
        raise ValueError("FISV corporate action: alternate bar must be revalidated")
    patch = catalog["evidence"]["fisv"]
    frame = pd.DataFrame([{**patch["fields"], "ticker": "FISV", "date": pd.Timestamp(patch["date"])}])
    path = work / "fisv.parquet"; frame.to_parquet(path, index=False); paths.append(path)
    prices, provenance = replay.merge_sources(paths)
    write_json(catalog, work / "catalog.json")
    provenance.update({"catalogSha256": replay.digest(work / "catalog.json"),
                       "engineSha256": replay.digest(Path(replay.engine.__file__)),
                       "configSha256": replay.digest(replay.engine.CONFIG_PATH),
                       "replaySha256": replay.digest(Path(replay.__file__)),
                       "adjustmentCheckSha256": replay.digest(work / "fisv-adjustments.json")})
    bundles = replay.generate(prices, catalog, replay.MIN_START, end, provenance)
    replay.publish_bundles(bundles, provenance, end, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", default="today")
    parser.add_argument("--output", type=Path, default=Path("public/data/trading-replays"))
    parser.add_argument("--work", type=Path, default=Path("action-output/replay-refresh"))
    args = parser.parse_args()
    refresh(pd.Timestamp(replay.korean_today() if args.as_of == "today" else args.as_of), args.output, args.work)


if __name__ == "__main__":
    main()
