#!/usr/bin/env python3
"""Build the static KR/US stock and ETF search catalog.

This is a maintenance script, not part of the production request path. The
generated JSON is committed so the deployed app searches locally without
calling a market-data API for each keystroke.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen

import FinanceDataReader as fdr


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "data" / "instruments.json"
NASDAQ_LISTED_URL = (
    "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
)
OTHER_LISTED_URL = (
    "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
)

NON_EQUITY_NAME = re.compile(
    r"\b("
    r"warrants?|rights?|units?|senior notes?|subordinated notes?|"
    r"debentures?|bonds?|when issued"
    r")\b",
    re.IGNORECASE,
)

US_MARKETS = {
    "Q": "NASDAQ Global Select",
    "G": "NASDAQ Global Market",
    "S": "NASDAQ Capital Market",
    "A": "NYSE American",
    "N": "NYSE",
    "P": "NYSE Arca",
    "Z": "Cboe BZX",
    "V": "IEX",
}


def download_text(url: str) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": (
                "balance-instrument-catalog/1.0 "
                "(static symbol directory refresh)"
            )
        },
    )
    with urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8-sig")


def first_value(row: dict[str, Any], names: Iterable[str]) -> str:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip() not in {"", "nan", "None"}:
            return str(value).strip()
    return ""


def normalized_kr_ticker(value: str) -> str:
    value = value.strip()
    if value.isdigit():
        return value.zfill(6)
    return value.upper()


def normalized_market(value: str) -> str:
    upper = value.strip().upper()
    aliases = {
        "KOSPI": "KOSPI",
        "STK": "KOSPI",
        "KOSDAQ": "KOSDAQ",
        "KSQ": "KOSDAQ",
        "KONEX": "KONEX",
        "KNX": "KONEX",
    }
    return aliases.get(upper, upper or "KRX")


def load_korean_instruments() -> list[dict[str, str]]:
    stock_frame = fdr.StockListing("KRX")
    etf_frame = fdr.StockListing("ETF/KR")

    etfs: dict[str, dict[str, str]] = {}
    for row in etf_frame.to_dict("records"):
        ticker = normalized_kr_ticker(
            first_value(row, ("Symbol", "Code", "종목코드", "단축코드"))
        )
        name = first_value(row, ("Name", "종목명", "한글종목명"))
        if not ticker or not name:
            continue
        etfs[ticker] = {
            "ticker": ticker,
            "name": name,
            "market": "KRX",
            "country": "KR",
            "assetType": "ETF",
        }

    stocks: dict[str, dict[str, str]] = {}
    for row in stock_frame.to_dict("records"):
        ticker = normalized_kr_ticker(
            first_value(row, ("Symbol", "Code", "종목코드", "단축코드"))
        )
        name = first_value(row, ("Name", "종목명", "한글종목명"))
        if not ticker or not name or ticker in etfs:
            continue
        market = normalized_market(
            first_value(row, ("Market", "MarketId", "시장구분", "시장"))
        )
        if market not in {"KOSPI", "KOSDAQ", "KONEX", "KRX"}:
            continue
        stocks[ticker] = {
            "ticker": ticker,
            "name": name,
            "market": market,
            "country": "KR",
            "assetType": "STOCK",
        }

    return [*stocks.values(), *etfs.values()]


def clean_security_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip(" -")


def include_us_security(name: str, is_etf: bool) -> bool:
    return is_etf or not NON_EQUITY_NAME.search(name)


def parse_nasdaq_listed(text: str) -> list[dict[str, str]]:
    rows = csv.DictReader(io.StringIO(text), delimiter="|")
    instruments: list[dict[str, str]] = []
    for row in rows:
        ticker = (row.get("Symbol") or "").strip().upper()
        name = clean_security_name(row.get("Security Name") or "")
        if (
            not ticker
            or ticker.startswith("FILE CREATION TIME")
            or row.get("Test Issue") != "N"
            or not name
        ):
            continue
        is_etf = row.get("ETF") == "Y"
        if not include_us_security(name, is_etf):
            continue
        instruments.append(
            {
                "ticker": ticker,
                "name": name,
                "market": US_MARKETS.get(
                    (row.get("Market Category") or "").strip(), "NASDAQ"
                ),
                "country": "US",
                "assetType": "ETF" if is_etf else "STOCK",
            }
        )
    return instruments


def parse_other_listed(text: str) -> list[dict[str, str]]:
    rows = csv.DictReader(io.StringIO(text), delimiter="|")
    instruments: list[dict[str, str]] = []
    for row in rows:
        ticker = (row.get("ACT Symbol") or "").strip().upper()
        name = clean_security_name(row.get("Security Name") or "")
        if (
            not ticker
            or ticker.startswith("FILE CREATION TIME")
            or row.get("Test Issue") != "N"
            or not name
        ):
            continue
        is_etf = row.get("ETF") == "Y"
        if not include_us_security(name, is_etf):
            continue
        instruments.append(
            {
                "ticker": ticker,
                "name": name,
                "market": US_MARKETS.get(
                    (row.get("Exchange") or "").strip(), "US"
                ),
                "country": "US",
                "assetType": "ETF" if is_etf else "STOCK",
            }
        )
    return instruments


def deduplicate(
    instruments: Iterable[dict[str, str]],
) -> list[dict[str, str]]:
    by_key: dict[str, dict[str, str]] = {}
    for instrument in instruments:
        key = f"{instrument['country']}:{instrument['ticker']}"
        existing = by_key.get(key)
        if existing is None or (
            existing["assetType"] != "ETF"
            and instrument["assetType"] == "ETF"
        ):
            by_key[key] = instrument
    return sorted(
        by_key.values(),
        key=lambda item: (
            0 if item["country"] == "KR" else 1,
            item["market"],
            item["ticker"],
        ),
    )


def main() -> int:
    korean = load_korean_instruments()
    nasdaq = parse_nasdaq_listed(download_text(NASDAQ_LISTED_URL))
    other_us = parse_other_listed(download_text(OTHER_LISTED_URL))
    instruments = deduplicate([*korean, *nasdaq, *other_us])

    counts = {
        "total": len(instruments),
        "krStocks": sum(
            item["country"] == "KR" and item["assetType"] == "STOCK"
            for item in instruments
        ),
        "krEtfs": sum(
            item["country"] == "KR" and item["assetType"] == "ETF"
            for item in instruments
        ),
        "usStocks": sum(
            item["country"] == "US" and item["assetType"] == "STOCK"
            for item in instruments
        ),
        "usEtfs": sum(
            item["country"] == "US" and item["assetType"] == "ETF"
            for item in instruments
        ),
    }
    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "counts": counts,
            "sources": [
                {
                    "name": "KRX listings via FinanceDataReader",
                    "url": "https://data.krx.co.kr/",
                },
                {
                    "name": "Nasdaq Trader Nasdaq-listed directory",
                    "url": NASDAQ_LISTED_URL,
                },
                {
                    "name": "Nasdaq Trader other-listed directory",
                    "url": OTHER_LISTED_URL,
                },
            ],
        },
        "instruments": instruments,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
