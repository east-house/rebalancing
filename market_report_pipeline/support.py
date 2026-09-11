"""Provider adapters shared by the standalone market-report collector."""

from __future__ import annotations

import random
import logging
import time
from io import BytesIO, StringIO
from pathlib import Path
from zipfile import ZipFile

import pandas as pd
import requests

from .io_utils import atomic_write_parquet
from .price_observation import save_observation, utc_stamp


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MARKET_CACHE_ROOT = PROJECT_ROOT / "data" / "cache" / "market-report"
STOCK_CACHE = MARKET_CACHE_ROOT / "stocks"
UNIVERSE_CACHE = MARKET_CACHE_ROOT / "universe"

WIKIPEDIA_SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_CHART_FALLBACK_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
FRED_GRAPH_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
PRICE_COLUMNS = ["open", "high", "low", "close", "volume"]
LOGGER = logging.getLogger(__name__)


class PriceDataNotReady(RuntimeError):
    """The response lacks a complete quote for the fixed expected session."""


def _retry_delay_seconds(error: Exception, attempt: int) -> float:
    """Return a bounded exponential delay, honoring numeric Retry-After."""

    response = getattr(error, "response", None)
    retry_after = response.headers.get("Retry-After") if response is not None else None
    try:
        requested_delay = float(retry_after) if retry_after is not None else 0.0
    except (TypeError, ValueError):
        requested_delay = 0.0
    exponential_delay = min(30.0, float(2 ** (attempt - 1)))
    return min(30.0, max(requested_delay, exponential_delay)) + random.uniform(0.0, 0.25)


def yahoo_symbol(symbol: str) -> str:
    return str(symbol).strip().upper().replace(".", "-")


def safe_symbol(symbol: str) -> str:
    return yahoo_symbol(symbol).replace("^", "INDEX_").replace("/", "_")


def _apply_adjusted_ohlc(frame: pd.DataFrame) -> pd.DataFrame:
    """Use adjusted OHLC when available and preserve raw prices otherwise.

    Yahoo can publish a completed quote row before its adjusted-close series is
    populated. Multiplying that row by a missing adjustment factor used to turn
    valid raw OHLC into NaN and poison the incremental cache.
    """

    result = frame.copy()
    raw_close = pd.to_numeric(result["close"], errors="coerce")
    adjusted = pd.to_numeric(result["adj_close"], errors="coerce")
    valid_factor = adjusted.notna() & raw_close.notna() & raw_close.ne(0)
    factor = (adjusted / raw_close).where(valid_factor, 1.0)
    for column in ("open", "high", "low"):
        result[column] = pd.to_numeric(result[column], errors="coerce") * factor
    result["close"] = adjusted.where(adjusted.notna(), raw_close)
    return result


def fetch_sp500_snapshot(as_of: pd.Timestamp, *, refresh: bool = False) -> pd.DataFrame:
    """Fetch and cache the current S&P 500 table with sector and CIK metadata."""

    target = UNIVERSE_CACHE / f"sp500_{as_of:%Y%m%d}.parquet"
    if target.exists() and not refresh:
        return pd.read_parquet(target)

    response = requests.get(
        WIKIPEDIA_SP500_URL,
        headers={"User-Agent": "rebalancing-market-report/1.0"},
        timeout=30,
    )
    response.raise_for_status()
    tables = pd.read_html(StringIO(response.text), header=0)
    if not tables or "Symbol" not in tables[0].columns:
        raise RuntimeError("S&P 500 구성종목 표를 찾지 못했습니다.")
    raw = tables[0].copy()
    renamed = raw.rename(
        columns={
            "Symbol": "ticker",
            "Security": "name",
            "GICS Sector": "sector",
            "GICS Sub-Industry": "industry",
            "Date added": "date_added",
            "CIK": "cik",
        }
    )
    required = ["ticker", "name", "sector", "industry", "date_added", "cik"]
    result = renamed[required].copy()
    result["ticker"] = result["ticker"].astype(str).str.strip().str.upper()
    result["yahoo_symbol"] = result["ticker"].map(yahoo_symbol)
    result["cik"] = result["cik"].astype(str).str.replace(r"\.0$", "", regex=True).str.zfill(10)
    result["date_added"] = pd.to_datetime(result["date_added"], errors="coerce")
    result["snapshot_date"] = as_of.normalize()
    if result["ticker"].duplicated().any() or len(result) < 490:
        raise RuntimeError("S&P 500 구성종목 스냅샷의 개수 또는 중복 검증에 실패했습니다.")
    atomic_write_parquet(result, target)
    return result


def _download_yahoo_frame(
    symbol: str,
    start: pd.Timestamp,
    end_exclusive: pd.Timestamp,
    *,
    timeout: int,
    max_retries: int,
    expected_latest: pd.Timestamp | None = None,
    single_attempt: int | None = None,
    diagnostics_dir: Path | None = None,
) -> pd.DataFrame:
    """Download split/dividend-adjusted daily OHLCV from Yahoo Chart."""

    mapped = yahoo_symbol(symbol)
    start_utc = pd.Timestamp(start)
    end_utc = pd.Timestamp(end_exclusive)
    start_utc = start_utc.tz_localize("UTC") if start_utc.tzinfo is None else start_utc.tz_convert("UTC")
    end_utc = end_utc.tz_localize("UTC") if end_utc.tzinfo is None else end_utc.tz_convert("UTC")
    params = {
        "period1": int(start_utc.timestamp()),
        "period2": int(end_utc.timestamp()),
        "interval": "1d",
        "includeAdjustedClose": "true",
        "events": "div,splits",
    }
    headers = {
        "Accept": "application/json",
        "User-Agent": "rebalancing-market-report/1.0 data-pipeline",
    }
    last_error: Exception | None = None
    if single_attempt is not None and not 1 <= single_attempt <= max_retries:
        raise ValueError("single_attempt must be within the shared retry budget")
    attempts = [single_attempt] if single_attempt is not None else range(1, max_retries + 1)
    for attempt in attempts:
        response = None
        ready = False
        diagnostic_error = None
        started = utc_stamp()
        endpoint = YAHOO_CHART_URL if attempt % 2 else YAHOO_CHART_FALLBACK_URL
        url = endpoint.format(symbol=mapped)
        try:
            response = requests.get(
                url,
                params=params,
                headers=headers,
                timeout=timeout,
            )
            response.raise_for_status()
            payload = response.json()["chart"]["result"][0]
            timestamps = payload.get("timestamp") or []
            quote = payload["indicators"]["quote"][0]
            adjusted = payload["indicators"].get("adjclose", [{}])[0].get("adjclose", [])
            frame = pd.DataFrame(
                quote,
                index=pd.to_datetime(timestamps, unit="s", utc=True).tz_convert(None).normalize(),
            )
            frame["adj_close"] = (
                pd.Series(adjusted, dtype="float64")
                .reindex(range(len(frame)))
                .to_numpy()
            )
            frame.index.name = "date"
            frame = frame.reset_index()
            frame = frame.loc[
                frame["date"].between(start.normalize(), end_exclusive.normalize(), inclusive="left")
            ].copy()
            for column in [*PRICE_COLUMNS, "adj_close"]:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
            frame = _apply_adjusted_ohlc(frame)
            if expected_latest is not None:
                expected = pd.Timestamp(expected_latest).normalize()
                required = ["open", "high", "low", "close"]
                complete = frame.dropna(subset=["date", *required])
                target = frame.loc[frame["date"].eq(expected)]
                if not complete["date"].eq(expected).any():
                    missing = [column for column in required if target.empty or target[column].isna().all()]
                    raise PriceDataNotReady(
                        f"Price data not ready: expected={expected.date()}, "
                        f"response_latest={frame['date'].max()}, completed_latest={complete['date'].max()}, "
                        f"missing_ohlc={missing}, attempt={attempt}/{max_retries}"
                    )
            frame["ticker"] = str(symbol).upper()
            frame["provider_symbol"] = mapped
            result = frame[
                ["date", "ticker", "provider_symbol", "open", "high", "low", "close", "volume"]
            ].sort_values("date").drop_duplicates("date", keep="last")
            result.attrs["collection_attempts"] = attempt
            ready = True
            return result
        except Exception as error:  # noqa: BLE001
            diagnostic_error = f"{type(error).__name__}: {error}"
            last_error = error
            if isinstance(error, PriceDataNotReady):
                LOGGER.warning("Yahoo %s: %s", symbol, error)
            if single_attempt is None and attempt < max_retries:
                time.sleep(_retry_delay_seconds(error, attempt))
        finally:
            save_observation(diagnostics_dir, symbol=symbol, url=url, params=params,
                             expected=expected_latest, started=started, response=response,
                             ready=ready, error=diagnostic_error, attempt=attempt)
    raise RuntimeError(f"Yahoo {symbol} 수집 실패: {last_error}") from last_error


def _read_fred_response(response: requests.Response) -> pd.DataFrame:
    disposition = response.headers.get("content-disposition", "")
    if "zip" in disposition.lower() or response.content[:2] == b"PK":
        frames: list[pd.DataFrame] = []
        with ZipFile(BytesIO(response.content)) as archive:
            for name in archive.namelist():
                if name.lower().endswith(".csv"):
                    frames.append(pd.read_csv(archive.open(name)))
        if not frames:
            raise RuntimeError("FRED ZIP에 CSV가 없습니다.")
        normalized: list[pd.DataFrame] = []
        for frame in frames:
            if "observation_date" in frame.columns:
                frame["observation_date"] = pd.to_datetime(frame["observation_date"])
                frame = frame.set_index("observation_date")
            normalized.append(frame)
        return pd.concat(normalized, axis=1)
    frame = pd.read_csv(BytesIO(response.content))
    date_column = "observation_date" if "observation_date" in frame.columns else "DATE"
    frame[date_column] = pd.to_datetime(frame[date_column])
    return frame.set_index(date_column)
