"""Calendar dates are business keys; timestamps are UTC instants."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

KST = ZoneInfo("Asia/Seoul")
POLICY_VERSION = "report-time-v1"
PORTFOLIO_EVENING_START = "2026-09-14"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def korean_today(now: datetime | None = None) -> date:
    return (now or utc_now()).astimezone(KST).date()


def calendar_date(value: object) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    stamp = pd.Timestamp(value)
    if pd.isna(stamp):
        raise ValueError("Invalid calendar date")
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert(KST)
    if stamp != stamp.normalize():
        raise ValueError("A calendar date must not contain a time of day")
    return stamp.date()


@lru_cache(maxsize=16)
def market_calendar(year: int):
    return xcals.get_calendar("XNYS", start=f"{year - 2}-01-01", end=f"{year + 2}-12-31")


def scheduled_for(day: object, kind: str = "morning") -> datetime:
    clock = time(19, 0) if kind == "portfolio" else time(7, 30) if kind == "morning" else time(19, 13)
    return datetime.combine(calendar_date(day), clock, KST).astimezone(timezone.utc)


def expected_market_date(day: object) -> pd.Timestamp:
    target = calendar_date(day)
    cal = market_calendar(target.year)
    session = cal.date_to_session(pd.Timestamp(target - timedelta(days=1)), direction="previous")
    return pd.Timestamp(session).tz_localize(None).normalize()


def next_execution_date(day: object) -> pd.Timestamp:
    target = calendar_date(day)
    session = market_calendar(target.year).date_to_session(pd.Timestamp(target), direction="next")
    return pd.Timestamp(session).tz_localize(None).normalize()


def report_context(day: object, kind: str = "morning") -> dict:
    target = calendar_date(day)
    expected = expected_market_date(target)
    close = market_calendar(target.year).session_close(expected)
    return {
        "policyVersion": POLICY_VERSION,
        "reportDateKst": target.isoformat(),
        "marketSessionDate": str(expected.date()),
        "scheduledFor": scheduled_for(target, kind).isoformat(),
        "dataCutoffAt": close.isoformat(),
        "calendarVersion": xcals.__version__,
    }


def due_dates(kind: str, start: object, completed: set[str], now: datetime | None = None) -> list[str]:
    instant = now or utc_now()
    if instant.tzinfo is None:
        raise ValueError("Planner requires a timezone-aware clock")
    day = calendar_date(start)
    end = korean_today(instant)
    weekdays = {0, 1, 2, 3, 4} if kind in {"morning", "portfolio"} else {1, 2, 3, 4, 5}
    result = []
    while day <= end:
        if day.weekday() in weekdays and scheduled_for(day, kind) <= instant and day.isoformat() not in completed:
            result.append(day.isoformat())
        day += timedelta(days=1)
    return result
