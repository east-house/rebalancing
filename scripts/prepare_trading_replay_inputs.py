"""Build separate replay inputs from preserved sources; do not edit source caches."""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
import zipfile

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_report_pipeline.io_utils import write_json
from market_report_pipeline.support import safe_symbol
from market_report_pipeline.trading_replay import FIELDS, valid_bars


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--revision", type=Path, required=True)
    parser.add_argument("--later-revision", type=Path, required=True)
    parser.add_argument("--fisv-history", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("data/cache/market-report/stocks"))
    parser.add_argument("--output", type=Path, default=Path("action-output/replay-inputs"))
    args = parser.parse_args()
    old_payload = json.loads(args.revision.read_text())
    later_payload = json.loads(args.later_revision.read_text())
    if old_payload["parse"]["revid"] != 1370105675 or later_payload["parse"]["revid"] != 1373104626:
        raise ValueError("This evidence import requires the reviewed August 19 / September 4 revisions")
    old = pd.read_html(StringIO(old_payload["parse"]["text"]["*"]))[0]
    later = pd.read_html(StringIO(later_payload["parse"]["text"]["*"]))[0]
    if set(old.Symbol) != set(later.Symbol) or len(old) != 503:
        raise ValueError("Membership changed; a dated membership timeline is required")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.archive) as archive:
        matches = [n for n in archive.namelist() if n.endswith("input_prices.parquet")]
        if len(matches) != 1:
            raise ValueError("Expected exactly one preserved input_prices.parquet")
        pd.read_parquet(BytesIO(archive.read(matches[0]))).to_parquet(output / "primary.parquet", index=False)
    cached = [pd.read_parquet(p) for p in sorted(args.cache.glob("*.parquet"))]
    pd.concat(cached, ignore_index=True).to_parquet(output / "cache-supplement.parquet", index=False)

    tables = pd.read_html(StringIO(args.fisv_history.read_text()), header=0)
    found = None
    for table in tables:
        if isinstance(table.columns, pd.MultiIndex):
            table.columns = table.columns.get_level_values(0)
        if "Open" not in table.columns or "Close" not in table.columns:
            continue
        dates = table.iloc[:, 0].astype(str)
        match = table.loc[dates.str.contains("2025-11-12", regex=False)]
        if len(match) == 1:
            found = match.iloc[0]
            break
    if found is None:
        raise ValueError("FISV November 12 bar is absent from the source")
    bar = {"date": pd.Timestamp("2025-11-12"), "ticker": "FISV", "provider_symbol": "FISV"}
    for field in FIELDS:
        value = found[field.title()]
        if isinstance(value, pd.Series):
            value = value.iloc[0]
        bar[field] = float(str(value).replace(",", ""))
    frame = pd.DataFrame([bar])
    if not valid_bars(frame).all():
        raise ValueError("Invalid FISV alternate-source bar")
    # Reviewed one-date exception, not a general raw/adjusted price conversion.
    frame.to_parquet(output / "fisv-supplement.parquet", index=False)
    catalog = {
        "schemaVersion": 1, "validFrom": "2026-08-31", "verifiedThrough": "2026-09-10",
        "sourceRevision": "wikipedia-1370105675", "members": [{"ticker": s} for s in old.Symbol],
        "listingHistory": {
            "FDXF": {"firstTradingSession": "2026-05-27", "source": "https://investor.fedex.com/news-and-events/investor-news/investor-news-details/2026/FedEx-Board-of-Directors-Approves-Spin-off-of-FedEx-Freight/default.aspx"},
            "HONA": {"firstTradingSession": "2026-06-15", "source": "https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2026-399"},
            "Q": {"firstTradingSession": "2025-10-27", "source": "https://ir.qnityelectronics.com/sec-filings/all-sec-filings/content/0001193125-25-240313/0001193125-25-240313.pdf"},
        },
        "evidence": {
            "membership": "https://en.wikipedia.org/w/index.php?oldid=1370105675",
            "laterRevision": "https://en.wikipedia.org/w/index.php?oldid=1373104626",
            "fisv": {"source": "https://chartexchange.com/symbol/nasdaq-fisv/historical/", "date": "2025-11-12",
                     "basis": "Alternate-feed bar; no intervening FISV dividend/split adjustment. Only this missing date is replaced.",
                     "fields": {f: bar[f] for f in FIELDS}},
            "files": [{"file": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                      for p in [args.archive, args.revision, args.later_revision, args.fisv_history]],
        },
    }
    write_json(catalog, output / "catalog.json")
    print(json.dumps({"output": str(output), "fisv": catalog["evidence"]["fisv"]}))


if __name__ == "__main__":
    main()
