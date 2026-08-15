#!/usr/bin/env python3
"""Build the managed ETF research bundles and optionally publish them to R2.

The production application only reads versioned JSON. This maintenance job is
the one place that talks to external market pages, keeping user requests free
from vendor calls and rate-limit failures.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import FinanceDataReader as fdr
from bs4 import BeautifulSoup
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "etf-research-universe.json"
DEFAULT_OUTPUT = ROOT / "public" / "data"
NAVER_ITEM_URL = "https://finance.naver.com/item/main.naver?code={ticker}"


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def percent(value: float | None) -> float | None:
    return round(value * 100, 4) if value is not None else None


def normalize_ticker(value: Any) -> str:
    return str(value).strip().split(".")[0].zfill(6)


def fetch_html(ticker: str, retries: int, delay: float) -> str:
    url = NAVER_ITEM_URL.format(ticker=ticker)
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = Request(
                url,
                headers={"User-Agent": "portfolio-research-static-builder/1.0"},
            )
            with urlopen(request, timeout=30) as response:
                charset = response.headers.get_content_charset() or "euc-kr"
                return response.read().decode(charset, errors="replace")
        except Exception as error:  # pragma: no cover - network behavior
            last_error = error
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{ticker} 상품 페이지 수집 실패: {last_error}")


def parse_percent(text: str) -> float | None:
    match = re.search(r"(-?[0-9]+(?:\.[0-9]+)?)\s*%", text.replace(",", ""))
    return finite(match.group(1)) if match else None


def parse_naver_profile(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    issuer = None
    benchmark = None
    listing_date = None
    expense = None

    fee_table = soup.find("table", attrs={"summary": re.compile("펀드보수")})
    if fee_table:
        expense = parse_percent(fee_table.get_text(" ", strip=True))
        for row in fee_table.find_all("tr"):
            header = row.find("th")
            value = row.find("td")
            if header and value and "자산운용사" in header.get_text(" ", strip=True):
                issuer = value.get_text(" ", strip=True).replace("(주)", "").strip()

    for row in soup.find_all("tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["th", "td"])]
        joined = " ".join(cells)
        if not issuer and ("운용사" in joined or "자산운용" in joined):
            issuer_match = re.search(r"([가-힣A-Za-z0-9& ]+자산운용)", joined)
            if issuer_match:
                issuer = issuer_match.group(1).strip()
        if not benchmark and ("기초지수" in joined or "추종지수" in joined) and len(cells) >= 2:
            benchmark = cells[-1].strip()
        if not expense and ("총보수" in joined or "펀드보수" in joined or "운용보수" in joined):
            expense = parse_percent(joined)
        if not listing_date and "상장일" in joined:
            date_match = re.search(r"(20\d{2})[./-](\d{1,2})[./-](\d{1,2})", joined)
            if date_match:
                listing_date = "-".join(
                    [date_match.group(1), date_match.group(2).zfill(2), date_match.group(3).zfill(2)]
                )

    if expense is None:
        fee_match = re.search(
            r"(?:총보수|펀드보수|운용보수).{0,80}?([0-9]+(?:\.[0-9]+)?)\s*%",
            text,
        )
        expense = finite(fee_match.group(1)) if fee_match else None

    holdings: list[dict[str, Any]] = []
    for table in soup.find_all("table"):
        table_text = table.get_text(" ", strip=True)
        if "구성종목" not in table_text and "구성자산" not in table_text:
            continue
        for row in table.find_all("tr"):
            cells = [cell.get_text(" ", strip=True) for cell in row.find_all("td")]
            if len(cells) < 2:
                continue
            weight = parse_percent(cells[-1])
            if weight is None or weight < 0 or weight > 100:
                continue
            name = next((cell for cell in cells[:-1] if cell and not re.fullmatch(r"[0-9,.-]+", cell)), "")
            if not name:
                continue
            code = ""
            link = row.find("a", href=re.compile(r"code=\d+"))
            if link:
                code_match = re.search(r"code=(\d+)", link.get("href", ""))
                code = code_match.group(1) if code_match else ""
            holdings.append({"key": code or name, "name": name, "weightPercent": weight})
        if holdings:
            break

    return {
        "issuer": issuer,
        "benchmarkName": benchmark,
        "listingDate": listing_date,
        "expenseRatioPercent": expense,
        "holdings": holdings,
    }


def maximum_drawdown(closes: list[float]) -> float | None:
    if not closes:
        return None
    peak = closes[0]
    drawdown = 0.0
    for close in closes:
        peak = max(peak, close)
        if peak > 0:
            drawdown = min(drawdown, close / peak - 1)
    return percent(drawdown)


def deviation(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    average = sum(values) / len(values)
    variance = sum((value - average) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(variance)


def build_metrics(frame: Any, listing: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    frame = frame.sort_index()
    points = [
        {"date": index.strftime("%Y-%m-%d"), "close": round(float(row["Close"]), 4)}
        for index, row in frame.iterrows()
        if finite(row.get("Close")) and float(row["Close"]) > 0
    ]
    closes = [point["close"] for point in points]
    returns = [closes[index] / closes[index - 1] - 1 for index in range(1, len(closes))]
    recent_returns = returns[-252:]
    downside_returns = [min(0, value) for value in recent_returns]
    volume_values = [
        finite(value) or 0 for value in frame.get("Volume", []).tolist()
    ][-20:]
    recent_closes = closes[-len(volume_values):] if volume_values else []
    trading_values = [close * volume for close, volume in zip(recent_closes, volume_values)]
    price = finite(listing.get("Price")) or (closes[-1] if closes else None)
    nav = finite(listing.get("NAV"))
    market_cap = finite(listing.get("MarCap"))
    if market_cap is not None and market_cap < 100_000_000:
        market_cap *= 100_000_000
    one_year_return = None
    if len(closes) >= 253 and closes[-253] > 0:
        one_year_return = percent(closes[-1] / closes[-253] - 1)
    return (
        {
            "latestPrice": price,
            "nav": nav,
            "navDeviationPercent": percent(price / nav - 1) if price and nav else None,
            "marketCapKrw": market_cap,
            "averageTradingValue20dKrw": round(sum(trading_values) / len(trading_values), 2) if trading_values else None,
            "return1yPercent": one_year_return,
            "volatility1yPercent": percent((deviation(recent_returns) or 0) * math.sqrt(252)) if len(recent_returns) >= 20 else None,
            "downsideVolatility1yPercent": percent(math.sqrt(sum(value * value for value in downside_returns) / len(downside_returns)) * math.sqrt(252)) if downside_returns else None,
            "maxDrawdown3yPercent": maximum_drawdown(closes[-756:]),
            "priceHistoryDays": len(points),
        },
        points,
    )


def build_bundles(config_path: Path, start: str, retries: int, delay: float) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    universe = json.loads(config_path.read_text(encoding="utf-8"))
    listing_frame = fdr.StockListing("ETF/KR")
    listing = {normalize_ticker(row.get("Symbol")): row for row in listing_frame.to_dict("records")}
    retrieved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    profiles: list[dict[str, Any]] = []
    series: list[dict[str, Any]] = []
    price_dates: list[str] = []

    for index, item in enumerate(universe, start=1):
        ticker = item["ticker"]
        listing_row = listing.get(ticker, {})
        try:
            frame = fdr.DataReader(ticker, start)
            html_profile = parse_naver_profile(fetch_html(ticker, retries, delay))
        except Exception as error:
            print(f"[{index:02d}/{len(universe)}] {ticker}: {error}")
            frame = fdr.DataReader(ticker, start)
            html_profile = {"issuer": None, "benchmarkName": None, "listingDate": None, "expenseRatioPercent": None, "holdings": []}
        metrics, points = build_metrics(frame, listing_row)
        if points:
            price_dates.append(points[-1]["date"])
        holdings = html_profile["holdings"]
        coverage = round(sum(holding["weightPercent"] for holding in holdings), 4)
        data_grade = "A" if coverage >= 90 and len(points) >= 756 else "B" if len(points) >= 252 else "C"
        exclusions: list[str] = []
        if not item["generatorEligible"]:
            exclusions.append("집중형·선물형 등 기본 생성기 대상이 아닌 분석 전용 ETF")
        if len(points) < 252:
            exclusions.append("가격 이력 1년 미만")
        usage = "GENERATOR_ELIGIBLE" if not exclusions else "ANALYSIS_ONLY"
        name = str(listing_row.get("Name") or ticker)
        sources = [
            {"name": "FinanceDataReader / Naver Finance", "url": NAVER_ITEM_URL.format(ticker=ticker), "retrievedAt": retrieved_at}
        ]
        profiles.append({
            "ticker": ticker,
            "name": name,
            "issuer": html_profile["issuer"],
            "assetClass": item["assetClass"],
            "assetClassLabel": item["assetClassLabel"],
            "strategyKey": item["strategyKey"],
            "strategyLabel": item["strategyLabel"],
            "benchmarkName": html_profile["benchmarkName"],
            "structure": item["structure"],
            "hedgeType": item["hedgeType"],
            "expenseRatioPercent": html_profile["expenseRatioPercent"],
            "listingDate": html_profile["listingDate"],
            "priceAsOf": points[-1]["date"] if points else None,
            "holdingsAsOf": points[-1]["date"] if points and holdings else None,
            "holdingsCoveragePercent": coverage,
            "holdings": holdings,
            "metrics": metrics,
            "dataGrade": data_grade,
            "usage": usage,
            "exclusionReasons": exclusions,
            "sources": sources,
        })
        series.append({"ticker": ticker, "name": name, "returnMode": "price", "distributionIncluded": False, "source": "FinanceDataReader / Naver Finance", "points": points})
        print(f"[{index:02d}/{len(universe)}] {ticker} {name}: {len(points)}일, 구성 {coverage:.1f}%")
        if delay > 0:
            time.sleep(delay)

    version_hash = hashlib.sha256(
        config_path.read_bytes() + Path(__file__).read_bytes()
    ).hexdigest()[:8]
    date_part = max(price_dates).replace("-", "") if price_dates else datetime.now(timezone.utc).strftime("%Y%m%d")
    version = f"{date_part}.{version_hash}"
    generated = retrieved_at
    analysis = {"schemaVersion": 1, "dataVersion": version, "generatedAt": generated, "profiles": profiles}
    returns = {"schemaVersion": 1, "dataVersion": version, "generatedAt": generated, "series": series}
    holdings_dates = [profile["holdingsAsOf"] for profile in profiles if profile["holdingsAsOf"]]
    manifest = {
        "schemaVersion": 1,
        "dataVersion": version,
        "generatedAt": generated,
        "priceAsOf": max(price_dates) if price_dates else None,
        "holdingsAsOf": max(holdings_dates) if holdings_dates else None,
        "etfCount": len(profiles),
        "generatorEligibleCount": sum(profile["usage"] == "GENERATOR_ELIGIBLE" for profile in profiles),
        "totalReturnCount": 0,
        "analysisPath": f"/api/etf-research/versions/{version}/analysis",
        "returnsPath": f"/api/etf-research/versions/{version}/returns",
    }
    return manifest, analysis, returns


def compact_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def write_static(output_dir: Path, manifest: dict[str, Any], analysis: dict[str, Any], returns: dict[str, Any]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("manifest", manifest), ("analysis", analysis), ("returns", returns)):
        (output_dir / f"etf-research-{name}.json").write_bytes(compact_bytes(value))


def publish_r2(manifest: dict[str, Any], analysis: dict[str, Any], returns: dict[str, Any]) -> None:
    import boto3

    account_id = os.environ["R2_ACCOUNT_ID"]
    bucket = os.environ["R2_BUCKET_NAME"]
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    version = manifest["dataVersion"]
    for name, value in (("analysis", analysis), ("returns", returns)):
        client.put_object(
            Bucket=bucket,
            Key=f"etf-research/versions/{version}/{name}.json.gz",
            Body=gzip.compress(compact_bytes(value), compresslevel=9),
            ContentType="application/json; charset=utf-8",
            ContentEncoding="gzip",
            CacheControl="public, max-age=31536000, immutable",
        )
    client.put_object(
        Bucket=bucket,
        Key="etf-research/latest/manifest.json",
        Body=compact_bytes(manifest),
        ContentType="application/json; charset=utf-8",
        CacheControl="public, max-age=300, s-maxage=3600",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--start", default="2016-01-01")
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--request-delay", type=float, default=0.15)
    parser.add_argument("--upload-r2", action="store_true")
    args = parser.parse_args()
    manifest, analysis, returns = build_bundles(args.config, args.start, args.retries, args.request_delay)
    write_static(args.output_dir, manifest, analysis, returns)
    if args.upload_r2:
        publish_r2(manifest, analysis, returns)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
