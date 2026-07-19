#!/usr/bin/env python3
"""Maintain one rolling year of R2 closing-price history per selected ticker.

The collection universe is resolved from the committed UI catalog and a
small policy file. Production splits that universe into deterministic shards.
New R2 objects are backfilled for one calendar year. Existing objects are
incrementally extended, checked for missing business-day rows, merged,
de-duplicated, and trimmed to the same rolling window.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "public" / "data" / "instruments.json"
DEFAULT_ACTIVE_CONFIG = ROOT / "config" / "active-close-prices.json"
DEFAULT_OUTPUT_DIR = ROOT / "action-output"
SEOUL = timezone(timedelta(hours=9), name="KST")

MAX_ACTIVE_INSTRUMENTS = 5_000
MAX_INSTRUMENTS_PER_RUN = 750
ROLLING_WINDOW_DAYS = 365
MAX_REPAIR_SPAN_DAYS = 7
NON_TRADING_CONFIRMATION_DELAY_DAYS = 7
RECENT_CLOSE_COUNT = 2
DEFAULT_SOFT_TIME_BUDGET_MINUTES = 45.0


def utc_iso(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    return (
        current.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def load_catalog(path: Path) -> list[dict[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    instruments = payload.get("instruments")
    if not isinstance(instruments, list) or not instruments:
        raise ValueError(f"No instruments found in {path}")

    required = {"ticker", "name", "market", "country", "assetType"}
    valid: list[dict[str, str]] = []
    for item in instruments:
        if not isinstance(item, dict) or not required.issubset(item):
            continue
        instrument = {key: str(item[key]).strip() for key in required}
        instrument["country"] = instrument["country"].upper()
        instrument["assetType"] = instrument["assetType"].upper()
        instrument["ticker"] = instrument["ticker"].upper()
        valid.append(instrument)

    if not valid:
        raise ValueError(f"No valid instruments found in {path}")
    return valid


def _string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} must contain non-empty ticker strings")
        result.append(item.strip().upper())
    if len(result) != len(set(result)):
        raise ValueError(f"{field} contains duplicate tickers")
    return result


def load_active_instruments(
    config_path: Path,
    catalog_path: Path = DEFAULT_CATALOG,
) -> list[dict[str, str]]:
    """Resolve the bounded collection universe from the committed catalog."""

    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Active-universe config must be a JSON object")
    if payload.get("schemaVersion") != 2:
        raise ValueError(
            "Unsupported active-universe schemaVersion; expected 2"
        )

    configured_max = payload.get("maxInstruments")
    if (
        not isinstance(configured_max, int)
        or isinstance(configured_max, bool)
        or configured_max < 1
        or configured_max > MAX_ACTIVE_INSTRUMENTS
    ):
        raise ValueError(
            "maxInstruments must be an integer between 1 and "
            f"{MAX_ACTIVE_INSTRUMENTS}"
        )

    groups = payload.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("Active-universe config must contain groups")

    catalog = load_catalog(catalog_path)
    selected: list[dict[str, str]] = []
    seen_groups: set[tuple[str, str]] = set()
    seen_instruments: set[tuple[str, str]] = set()

    for index, raw_group in enumerate(groups):
        field = f"groups[{index}]"
        if not isinstance(raw_group, dict):
            raise ValueError(f"{field} must be an object")

        country = str(raw_group.get("country", "")).strip().upper()
        asset_type = str(raw_group.get("assetType", "")).strip().upper()
        group_key = (country, asset_type)
        if country not in {"KR", "US"}:
            raise ValueError(f"{field}.country must be KR or US")
        if asset_type not in {"STOCK", "ETF"}:
            raise ValueError(f"{field}.assetType must be STOCK or ETF")
        if group_key in seen_groups:
            raise ValueError(f"Duplicate active-universe group: {group_key}")
        seen_groups.add(group_key)

        selection = str(raw_group.get("selection", "")).strip().lower()
        if selection not in {"all", "explicit"}:
            raise ValueError(
                f"{field}.selection must be all or explicit"
            )
        excluded = set(
            _string_list(raw_group.get("exclude", []), f"{field}.exclude")
        )

        candidates = sorted(
            (
                item
                for item in catalog
                if item["country"] == country
                and item["assetType"] == asset_type
                and item["ticker"] not in excluded
            ),
            key=lambda item: item["ticker"],
        )
        by_ticker = {item["ticker"]: item for item in candidates}
        if selection == "all":
            if "tickers" in raw_group:
                raise ValueError(
                    f"{field}.tickers is only valid for explicit selection"
                )
            minimum_count = raw_group.get("minimumCount", 1)
            if (
                not isinstance(minimum_count, int)
                or isinstance(minimum_count, bool)
                or minimum_count < 1
            ):
                raise ValueError(
                    f"{field}.minimumCount must be a positive integer"
                )
            if len(candidates) < minimum_count:
                raise ValueError(
                    f"{field} expected at least {minimum_count} instruments "
                    f"but only {len(candidates)} are available"
                )
            group_selected = candidates
        else:
            tickers = _string_list(
                raw_group.get("tickers", []),
                f"{field}.tickers",
            )
            if not tickers:
                raise ValueError(
                    f"{field}.tickers must not be empty"
                )
            overlap = excluded.intersection(tickers)
            if overlap:
                raise ValueError(
                    f"{field} cannot both select and exclude: "
                    + ", ".join(sorted(overlap))
                )
            missing_tickers = [
                ticker for ticker in tickers if ticker not in by_ticker
            ]
            if missing_tickers:
                raise ValueError(
                    f"{field} tickers are absent from its catalog group: "
                    + ", ".join(missing_tickers)
                )
            group_selected = [by_ticker[ticker] for ticker in tickers]

        for instrument in group_selected:
            key = (instrument["country"], instrument["ticker"])
            if key in seen_instruments:
                raise ValueError(f"Duplicate active instrument: {key}")
            seen_instruments.add(key)
            selected.append(instrument)

    if len(selected) > configured_max or len(selected) > MAX_ACTIVE_INSTRUMENTS:
        raise ValueError(
            f"Active universe exceeds {MAX_ACTIVE_INSTRUMENTS} instruments"
        )
    return selected


def select_shard(
    instruments: list[dict[str, str]],
    shard_count: int,
    shard_index: int,
) -> list[dict[str, str]]:
    """Split a stable universe without copying or dropping instruments."""

    if shard_count < 1:
        raise ValueError("shard_count must be at least 1")
    if shard_index < 0 or shard_index >= shard_count:
        raise ValueError(
            "shard_index must be between 0 and shard_count - 1"
        )
    return [
        instrument
        for position, instrument in enumerate(instruments)
        if position % shard_count == shard_index
    ]


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _normalise_prices(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not payload:
        return []
    raw_prices = payload.get("prices")
    if not isinstance(raw_prices, list):
        return []

    by_date: dict[date, float] = {}
    for item in raw_prices:
        if not isinstance(item, dict):
            continue
        price_date = _parse_date(item.get("date"))
        try:
            close = float(item.get("close"))
        except (TypeError, ValueError):
            continue
        if price_date is None or close <= 0:
            continue
        by_date[price_date] = close
    return [
        {"date": price_date.isoformat(), "close": by_date[price_date]}
        for price_date in sorted(by_date)
    ]


def _business_dates(start: date, end_exclusive: date) -> Iterable[date]:
    current = start
    while current < end_exclusive:
        if current.weekday() < 5:
            yield current
        current += timedelta(days=1)


@dataclass(frozen=True)
class FetchRange:
    start: date
    end: date
    purpose: str

    def __post_init__(self) -> None:
        if self.end <= self.start:
            raise ValueError("FetchRange end must be after start")


def plan_fetch_ranges(
    history: dict[str, Any] | None,
    today: date,
) -> list[FetchRange]:
    """Plan a backfill, an increment, and at most one bounded gap repair."""

    window_start = today - timedelta(days=ROLLING_WINDOW_DAYS)
    prices = _normalise_prices(history)
    price_dates = {
        parsed
        for item in prices
        if (parsed := _parse_date(item["date"])) is not None
        and window_start <= parsed <= today
    }
    if not price_dates:
        return [
            FetchRange(
                start=window_start,
                end=today + timedelta(days=1),
                purpose="backfill",
            )
        ]

    ranges: list[FetchRange] = []
    last_price_date = max(price_dates)
    incremental_start = max(window_start, last_price_date + timedelta(days=1))
    if incremental_start <= today:
        ranges.append(
            FetchRange(
                start=incremental_start,
                end=today + timedelta(days=1),
                purpose="incremental",
            )
        )

    non_trading_dates = {
        parsed
        for value in (history or {}).get("nonTradingDates", [])
        if (parsed := _parse_date(value)) is not None
    }
    missing = [
        candidate
        for candidate in _business_dates(
            max(window_start, min(price_dates)),
            min(last_price_date, today) + timedelta(days=1),
        )
        if candidate not in price_dates and candidate not in non_trading_dates
    ]
    if missing:
        first_missing = missing[0]
        repair_end = min(
            first_missing + timedelta(days=MAX_REPAIR_SPAN_DAYS),
            today + timedelta(days=1),
        )
        ranges.append(
            FetchRange(
                start=first_missing,
                end=repair_end,
                purpose="repair",
            )
        )
    return ranges


def _frame_index_date(value: Any) -> date:
    if hasattr(value, "date"):
        value = value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


class FinanceDataReaderProvider:
    def __init__(self) -> None:
        try:
            import FinanceDataReader as fdr
        except ImportError as error:
            raise RuntimeError(
                "FinanceDataReader is not installed. Run: "
                "pip install finance-datareader"
            ) from error
        self._fdr = fdr

    def fetch(
        self,
        instrument: dict[str, str],
        start: date,
        end: date,
    ) -> list[dict[str, Any]]:
        frame = self._fdr.DataReader(
            instrument["ticker"],
            start.isoformat(),
            end.isoformat(),
        )
        if frame is None or frame.empty:
            return []

        column = "Close" if "Close" in frame.columns else "Adj Close"
        if column not in frame.columns:
            raise ValueError(
                "Close column not returned "
                f"(columns={list(frame.columns)})"
            )

        points: list[dict[str, Any]] = []
        for index, raw_close in frame[column].dropna().items():
            price_date = _frame_index_date(index)
            close = float(raw_close)
            if start <= price_date < end and close > 0:
                points.append(
                    {"date": price_date.isoformat(), "close": close}
                )
        return points


def _history_bytes(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=9)


def _decode_history(data: bytes) -> dict[str, Any]:
    if data.startswith(b"\x1f\x8b"):
        data = gzip.decompress(data)
    payload = json.loads(data.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("R2 history object must contain a JSON object")
    return payload


def required_r2_environment() -> dict[str, str]:
    names = (
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
    )
    values = {name: os.environ.get(name, "").strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(
            "Missing R2 GitHub Actions secrets/variables: "
            + ", ".join(missing)
        )
    return values


def history_object_key(instrument: dict[str, str], prefix: str) -> str:
    base = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
    ticker = quote(instrument["ticker"], safe="")
    return f"{base}history/{instrument['country']}/{ticker}.json.gz"


def shard_quote_object_key(shard_index: int, prefix: str) -> str:
    base = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
    return f"{base}latest/quotes/shards/{shard_index}.json.gz"


def quote_from_history(history: dict[str, Any]) -> dict[str, Any] | None:
    instrument = history.get("instrument")
    if not isinstance(instrument, dict):
        return None
    prices = _normalise_prices(history)
    recent = prices[-RECENT_CLOSE_COUNT:]
    if not recent:
        return None

    required = ("ticker", "name", "country", "assetType")
    if any(not str(instrument.get(field, "")).strip() for field in required):
        return None
    country = str(instrument["country"]).strip().upper()
    return {
        "ticker": str(instrument["ticker"]).strip().upper(),
        "name": str(instrument["name"]).strip(),
        "country": country,
        "assetType": str(instrument["assetType"]).strip().upper(),
        "currency": "KRW" if country == "KR" else "USD",
        "closes": recent,
    }


class R2HistoryStore:
    def __init__(
        self,
        client: Any,
        bucket: str,
        prefix: str,
    ) -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    @classmethod
    def from_environment(cls, prefix: str) -> "R2HistoryStore":
        try:
            import boto3
        except ImportError as error:
            raise RuntimeError(
                "boto3 is not installed. Run: pip install boto3"
            ) from error

        values = required_r2_environment()
        client = boto3.client(
            "s3",
            endpoint_url=(
                "https://"
                f"{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
            ),
            aws_access_key_id=values["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        return cls(client, values["R2_BUCKET_NAME"], prefix)

    def load(self, instrument: dict[str, str]) -> dict[str, Any] | None:
        key = history_object_key(instrument, self.prefix)
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            response_data = getattr(error, "response", {})
            code = str(response_data.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        body = response["Body"]
        if hasattr(body, "read"):
            try:
                data = body.read()
            finally:
                if hasattr(body, "close"):
                    body.close()
        else:
            data = body
        return _decode_history(bytes(data))

    def save(
        self,
        instrument: dict[str, str],
        history: dict[str, Any],
    ) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=history_object_key(instrument, self.prefix),
            Body=_history_bytes(history),
            ContentType="application/json",
            ContentEncoding="gzip",
            CacheControl="private, no-cache",
        )

    def load_shard_quotes(
        self,
        shard_index: int,
    ) -> dict[str, Any] | None:
        key = shard_quote_object_key(shard_index, self.prefix)
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            response_data = getattr(error, "response", {})
            code = str(response_data.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        body = response["Body"]
        if hasattr(body, "read"):
            try:
                data = body.read()
            finally:
                if hasattr(body, "close"):
                    body.close()
        else:
            data = body
        return _decode_history(bytes(data))

    def save_shard_quotes(
        self,
        shard_index: int,
        shard_count: int,
        instruments: list[dict[str, str]],
        updated_quotes: list[dict[str, Any]],
        generated_at: str,
    ) -> tuple[str, int]:
        existing = self.load_shard_quotes(shard_index) or {}
        allowed = {
            (item["country"], item["ticker"]) for item in instruments
        }
        by_key: dict[tuple[str, str], dict[str, Any]] = {}
        raw_existing = existing.get("quotes")
        if isinstance(raw_existing, list):
            for quote_item in raw_existing:
                if not isinstance(quote_item, dict):
                    continue
                key = (
                    str(quote_item.get("country", "")).upper(),
                    str(quote_item.get("ticker", "")).upper(),
                )
                if key in allowed:
                    by_key[key] = quote_item
        for quote_item in updated_quotes:
            key = (
                str(quote_item.get("country", "")).upper(),
                str(quote_item.get("ticker", "")).upper(),
            )
            if key in allowed:
                by_key[key] = quote_item

        quotes = [
            by_key[key]
            for key in sorted(by_key)
        ]
        payload = {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "shard": {"count": shard_count, "index": shard_index},
            "expectedQuoteCount": len(instruments),
            "quoteCount": len(quotes),
            "quotes": quotes,
        }
        key = shard_quote_object_key(shard_index, self.prefix)
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=_history_bytes(payload),
            ContentType="application/json",
            ContentEncoding="gzip",
            CacheControl="private, no-cache",
        )
        return key, len(quotes)

    def save_run_summary(
        self,
        run_id: str,
        run_date: str,
        summary: dict[str, Any],
    ) -> dict[str, str]:
        base = f"{self.prefix}/" if self.prefix else ""
        dated_key = f"{base}runs/{run_date}/{run_id}.json"
        shard = summary.get("shard")
        if (
            isinstance(shard, dict)
            and isinstance(shard.get("count"), int)
            and shard["count"] > 1
            and isinstance(shard.get("index"), int)
        ):
            latest_key = (
                f"{base}latest/shards/{shard['index']}.json"
            )
        else:
            latest_key = f"{base}latest/run-summary.json"
        keys = {"run": dated_key, "latestRun": latest_key}
        summary["r2"] = {
            "status": "uploaded",
            "prefix": self.prefix,
            **keys,
        }
        data = json.dumps(
            summary,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        for key, cache_control in (
            (dated_key, "private, max-age=31536000, immutable"),
            (latest_key, "private, no-cache"),
        ):
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType="application/json; charset=utf-8",
                CacheControl=cache_control,
            )
        return keys


class MemoryHistoryStore:
    """Non-persistent store used by local and no-upload workflow checks."""

    def __init__(self) -> None:
        self.histories: dict[tuple[str, str], dict[str, Any]] = {}

    def load(self, instrument: dict[str, str]) -> dict[str, Any] | None:
        return self.histories.get(
            (instrument["country"], instrument["ticker"])
        )

    def save(
        self,
        instrument: dict[str, str],
        history: dict[str, Any],
    ) -> None:
        self.histories[
            (instrument["country"], instrument["ticker"])
        ] = history


def update_history(
    existing: dict[str, Any] | None,
    instrument: dict[str, str],
    fetched_points: list[dict[str, Any]],
    successful_ranges: list[FetchRange],
    today: date,
    updated_at: str | None = None,
) -> dict[str, Any]:
    window_start = today - timedelta(days=ROLLING_WINDOW_DAYS)
    merged_by_date: dict[date, float] = {}
    for item in [
        *_normalise_prices(existing),
        *_normalise_prices({"prices": fetched_points}),
    ]:
        price_date = _parse_date(item["date"])
        if price_date is not None and window_start <= price_date <= today:
            merged_by_date[price_date] = float(item["close"])

    non_trading_dates = {
        parsed
        for value in (existing or {}).get("nonTradingDates", [])
        if (parsed := _parse_date(value)) is not None
        and window_start <= parsed <= today
    }
    confirmation_cutoff = today - timedelta(
        days=NON_TRADING_CONFIRMATION_DELAY_DAYS
    )
    for fetch_range in successful_ranges:
        # A broad initial backfill can itself be incomplete. Only an explicit
        # follow-up repair is allowed to classify an absent weekday as a
        # confirmed market holiday; otherwise it remains eligible for repair.
        if fetch_range.purpose != "repair":
            continue
        for candidate in _business_dates(fetch_range.start, fetch_range.end):
            if (
                window_start <= candidate <= confirmation_cutoff
                and candidate not in merged_by_date
            ):
                non_trading_dates.add(candidate)
    non_trading_dates.difference_update(merged_by_date)

    prices = [
        {"date": price_date.isoformat(), "close": merged_by_date[price_date]}
        for price_date in sorted(merged_by_date)
    ]
    latest = prices[-1] if prices else None
    return {
        "schemaVersion": 1,
        "instrument": instrument,
        "source": "FinanceDataReader",
        "window": {
            "days": ROLLING_WINDOW_DAYS,
            "start": window_start.isoformat(),
            "end": today.isoformat(),
        },
        "updatedAt": updated_at or utc_iso(),
        "priceCount": len(prices),
        "latest": latest,
        "prices": prices,
        "nonTradingDates": [
            value.isoformat() for value in sorted(non_trading_dates)
        ],
    }


def _fetch_with_retries(
    provider: Any,
    instrument: dict[str, str],
    fetch_range: FetchRange,
    retries: int,
    sleep: Callable[[float], None],
) -> list[dict[str, Any]]:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return provider.fetch(
                instrument,
                fetch_range.start,
                fetch_range.end,
            )
        except Exception as error:
            last_error = error
            if attempt < retries:
                sleep(min(2 ** (attempt + 1), 8))
    assert last_error is not None
    raise last_error


def collect_active_histories(
    instruments: list[dict[str, str]],
    store: Any,
    provider: Any,
    today: date,
    soft_time_budget_seconds: float,
    retries: int = 1,
    request_delay: float = 0.25,
    max_consecutive_failures: int = 25,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    if len(instruments) > MAX_INSTRUMENTS_PER_RUN:
        raise ValueError(
            f"At most {MAX_INSTRUMENTS_PER_RUN} instruments may be collected "
            "in one run; use sharding for a larger universe"
        )
    if soft_time_budget_seconds <= 0:
        raise ValueError("soft_time_budget_seconds must be positive")
    if max_consecutive_failures < 1:
        raise ValueError("max_consecutive_failures must be positive")

    started = clock()
    stats: dict[str, Any] = {
        "requested": len(instruments),
        "processed": 0,
        "succeeded": 0,
        "partial": 0,
        "failed": 0,
        "skippedForTimeBudget": 0,
        "skippedForCircuitBreaker": 0,
        "newBackfills": 0,
        "existingUpdates": 0,
        "pricePointsStored": 0,
        "softTimeBudgetSeconds": soft_time_budget_seconds,
        "softTimeBudgetReached": False,
        "circuitBreakerReached": False,
    }
    failures: list[dict[str, Any]] = []
    latest_quotes: list[dict[str, Any]] = []
    consecutive_failures = 0

    def budget_reached() -> bool:
        return clock() - started >= soft_time_budget_seconds

    for position, instrument in enumerate(instruments):
        if budget_reached():
            remaining = len(instruments) - position
            stats["skippedForTimeBudget"] += remaining
            stats["softTimeBudgetReached"] = True
            break

        label = f"{instrument['country']}:{instrument['ticker']}"
        print(f"[{position + 1}/{len(instruments)}] {label}", flush=True)
        try:
            existing = store.load(instrument)
        except Exception as error:
            stats["processed"] += 1
            stats["failed"] += 1
            failures.append(
                {
                    **instrument,
                    "stage": "load",
                    "error": f"{type(error).__name__}: {error}"[:1000],
                    "failedAt": utc_iso(),
                }
            )
            consecutive_failures += 1
            if consecutive_failures >= max_consecutive_failures:
                stats["skippedForCircuitBreaker"] += (
                    len(instruments) - position - 1
                )
                stats["circuitBreakerReached"] = True
                break
            continue

        fetch_ranges = plan_fetch_ranges(existing, today)
        fetched_points: list[dict[str, Any]] = []
        successful_ranges: list[FetchRange] = []
        range_errors: list[str] = []
        stopped_for_budget = False

        for fetch_range in fetch_ranges:
            if budget_reached():
                stopped_for_budget = True
                break
            try:
                fetched_points.extend(
                    _fetch_with_retries(
                        provider,
                        instrument,
                        fetch_range,
                        retries,
                        sleep,
                    )
                )
                successful_ranges.append(fetch_range)
            except Exception as error:
                range_errors.append(
                    f"{fetch_range.purpose}: "
                    f"{type(error).__name__}: {error}"
                )

            if request_delay > 0:
                sleep(request_delay)

        if stopped_for_budget and not successful_ranges:
            remaining = len(instruments) - position
            stats["skippedForTimeBudget"] += remaining
            stats["softTimeBudgetReached"] = True
            break

        history = update_history(
            existing,
            instrument,
            fetched_points,
            successful_ranges,
            today,
        )
        if not history["prices"]:
            range_errors.append("No closing-price rows available")

        if range_errors and not history["prices"]:
            stats["processed"] += 1
            stats["failed"] += 1
            failures.append(
                {
                    **instrument,
                    "stage": "fetch",
                    "error": "; ".join(range_errors)[:1000],
                    "failedAt": utc_iso(),
                }
            )
            consecutive_failures += 1
        else:
            try:
                store.save(instrument, history)
                stats["processed"] += 1
                stats["succeeded"] += 1
                stats["pricePointsStored"] += history["priceCount"]
                if existing is None:
                    stats["newBackfills"] += 1
                else:
                    stats["existingUpdates"] += 1
                if range_errors:
                    stats["partial"] += 1
                    failures.append(
                        {
                            **instrument,
                            "stage": "partial-fetch",
                            "error": "; ".join(range_errors)[:1000],
                            "failedAt": utc_iso(),
                        }
                    )
                latest_quote = quote_from_history(history)
                if latest_quote is not None:
                    latest_quotes.append(latest_quote)
                consecutive_failures = 0
            except Exception as error:
                stats["processed"] += 1
                stats["failed"] += 1
                failures.append(
                    {
                        **instrument,
                        "stage": "save",
                        "error": f"{type(error).__name__}: {error}"[:1000],
                        "failedAt": utc_iso(),
                    }
                )
                consecutive_failures += 1

        if consecutive_failures >= max_consecutive_failures:
            stats["skippedForCircuitBreaker"] += (
                len(instruments) - position - 1
            )
            stats["circuitBreakerReached"] = True
            break

        if stopped_for_budget or budget_reached():
            remaining = len(instruments) - position - 1
            stats["skippedForTimeBudget"] += remaining
            stats["softTimeBudgetReached"] = True
            break

    stats["durationSeconds"] = round(clock() - started, 2)
    return stats, failures, latest_quotes


def write_run_outputs(
    output_dir: Path,
    summary: dict[str, Any],
    failures: list[dict[str, Any]],
) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = output_dir / "run-summary.json"
    failure_path = output_dir / "failed-tickers.json"
    markdown_path = output_dir / "summary.md"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    failure_path.write_text(
        json.dumps(
            {"meta": {"runId": summary["runId"]}, "failures": failures},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    markdown_path.write_text(
        "\n".join(
            [
                "## Rolling closing-price collection",
                "",
                f"- Run ID: `{summary['runId']}`",
                f"- Requested: {summary['requested']}",
                f"- Succeeded: {summary['succeeded']}",
                f"- Partial: {summary['partial']}",
                f"- Failed: {summary['failed']}",
                (
                    "- Skipped by soft time budget: "
                    f"{summary['skippedForTimeBudget']}"
                ),
                (
                    "- Skipped by circuit breaker: "
                    f"{summary['skippedForCircuitBreaker']}"
                ),
                f"- Duration: {summary['durationSeconds']} seconds",
                f"- R2: {summary['r2']['status']}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return {
        "summary": summary_path,
        "failures": failure_path,
        "markdown": markdown_path,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Maintain rolling R2 closing-price histories"
    )
    parser.add_argument(
        "--active-config",
        type=Path,
        default=DEFAULT_ACTIVE_CONFIG,
        help="Bounded active-universe configuration",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help="Read-only UI instrument catalog",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for run diagnostics",
    )
    parser.add_argument(
        "--max-instruments",
        type=int,
        default=None,
        help="Optional smaller prefix for manual test runs",
    )
    parser.add_argument(
        "--rotation-seed",
        type=int,
        default=0,
        help=(
            "Rotate collection order with a stable stride so a soft timeout "
            "does not repeatedly starve the same tail"
        ),
    )
    parser.add_argument(
        "--shard-count",
        type=int,
        default=1,
        help="Number of deterministic collection shards",
    )
    parser.add_argument(
        "--shard-index",
        type=int,
        default=0,
        help="Zero-based shard to collect in this process",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=1,
        choices=range(0, 4),
        metavar="{0,1,2,3}",
    )
    parser.add_argument(
        "--request-delay",
        type=float,
        default=0.25,
    )
    parser.add_argument(
        "--soft-time-budget-minutes",
        type=float,
        default=DEFAULT_SOFT_TIME_BUDGET_MINUTES,
    )
    parser.add_argument(
        "--max-consecutive-failures",
        type=int,
        default=25,
        help="Stop a shard when this many instruments fail in a row",
    )
    parser.add_argument(
        "--upload-r2",
        action="store_true",
        help="Read and write per-ticker history in R2",
    )
    parser.add_argument(
        "--r2-prefix",
        default="market-data",
        help="R2 object-key prefix",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started_at = datetime.now(timezone.utc)
    run_time = datetime.now(SEOUL)
    run_id = (
        f"{run_time.strftime('%Y%m%d-%H%M%S')}-"
        f"{uuid.uuid4().hex[:8]}"
    )

    try:
        universe = load_active_instruments(
            args.active_config,
            args.catalog,
        )
        universe_size = len(universe)
        instruments = select_shard(
            universe,
            args.shard_count,
            args.shard_index,
        )
        if instruments:
            rotation = (
                max(args.rotation_seed, 0) * 137
            ) % len(instruments)
            instruments = instruments[rotation:] + instruments[:rotation]
        if args.max_instruments is not None:
            if (
                args.max_instruments < 1
                or args.max_instruments > len(instruments)
            ):
                raise ValueError(
                    "--max-instruments must be between 1 and the resolved "
                    f"universe size ({len(instruments)})"
                )
            instruments = instruments[: args.max_instruments]
        if len(instruments) > MAX_INSTRUMENTS_PER_RUN:
            raise ValueError(
                f"Resolved shard has {len(instruments)} instruments; "
                f"the per-run maximum is {MAX_INSTRUMENTS_PER_RUN}. "
                "Increase --shard-count."
            )
        provider = FinanceDataReaderProvider()
        store: Any = (
            R2HistoryStore.from_environment(args.r2_prefix)
            if args.upload_r2
            else MemoryHistoryStore()
        )
    except Exception as error:
        print(f"Collector setup failed: {type(error).__name__}: {error}")
        return 1

    stats, failures, latest_quotes = collect_active_histories(
        instruments,
        store,
        provider,
        today=run_time.date(),
        soft_time_budget_seconds=args.soft_time_budget_minutes * 60,
        retries=args.retries,
        request_delay=max(args.request_delay, 0),
        max_consecutive_failures=args.max_consecutive_failures,
    )
    finished_at = datetime.now(timezone.utc)
    summary: dict[str, Any] = {
        "runId": run_id,
        "generatedAt": utc_iso(finished_at),
        "startedAt": utc_iso(started_at),
        "finishedAt": utc_iso(finished_at),
        "activeConfig": str(args.active_config),
        "catalog": str(args.catalog),
        "rollingWindowDays": ROLLING_WINDOW_DAYS,
        "universeSize": universe_size,
        "shard": {
            "count": args.shard_count,
            "index": args.shard_index,
        },
        **stats,
        "r2": {
            "status": "pending" if args.upload_r2 else "disabled",
            "prefix": args.r2_prefix.strip("/"),
        },
        "quoteSnapshot": {
            "status": "pending" if args.upload_r2 else "disabled",
            "updatedQuoteCount": len(latest_quotes),
        },
    }

    upload_failed = False
    if args.upload_r2:
        try:
            snapshot_key, snapshot_count = store.save_shard_quotes(
                args.shard_index,
                args.shard_count,
                instruments,
                latest_quotes,
                summary["generatedAt"],
            )
            summary["quoteSnapshot"] = {
                "status": "uploaded",
                "key": snapshot_key,
                "updatedQuoteCount": len(latest_quotes),
                "quoteCount": snapshot_count,
            }
        except Exception as error:
            upload_failed = True
            summary["quoteSnapshot"] = {
                "status": "failed",
                "updatedQuoteCount": len(latest_quotes),
                "error": f"{type(error).__name__}: {error}"[:1000],
            }
        try:
            keys = store.save_run_summary(
                run_id,
                run_time.strftime("%Y-%m-%d"),
                summary,
            )
            summary["r2"] = {
                "status": "uploaded",
                "prefix": args.r2_prefix.strip("/"),
                **keys,
            }
        except Exception as error:
            upload_failed = True
            summary["r2"] = {
                "status": "failed",
                "prefix": args.r2_prefix.strip("/"),
                "error": f"{type(error).__name__}: {error}"[:1000],
            }

    write_run_outputs(args.output_dir, summary, failures)
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if upload_failed or stats["succeeded"] == 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
