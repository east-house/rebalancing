from __future__ import annotations

import gzip
import io
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from scripts.collect_close_prices import (
    DEFAULT_ACTIVE_CONFIG,
    DEFAULT_CATALOG,
    FetchRange,
    MAX_ACTIVE_INSTRUMENTS,
    MAX_INSTRUMENTS_PER_RUN,
    MemoryHistoryStore,
    R2HistoryStore,
    ROLLING_WINDOW_DAYS,
    _provider_ticker,
    collect_active_histories,
    history_object_key,
    load_active_instruments,
    load_catalog,
    plan_fetch_ranges,
    quote_from_history,
    select_shard,
    shard_quote_object_key,
    update_history,
)


def instrument(ticker: str = "AAA") -> dict[str, str]:
    return {
        "ticker": ticker,
        "name": ticker,
        "market": "NASDAQ",
        "country": "US",
        "assetType": "STOCK",
    }


class ActiveUniverseTests(unittest.TestCase):
    def test_provider_uses_yahoo_class_share_symbol_format(self) -> None:
        self.assertEqual(_provider_ticker(instrument("BRK.B")), "BRK-B")
        korean = {
            **instrument("005930"),
            "country": "KR",
            "market": "KOSPI",
        }
        self.assertEqual(_provider_ticker(korean), "005930")

    def test_default_config_resolves_kr_all_and_100_explicit_us(
        self,
    ) -> None:
        catalog = load_catalog(DEFAULT_CATALOG)
        active = load_active_instruments(
            DEFAULT_ACTIVE_CONFIG,
            DEFAULT_CATALOG,
        )

        self.assertGreater(len(catalog), MAX_ACTIVE_INSTRUMENTS)
        self.assertEqual(len(active), 4_068)
        self.assertEqual(
            len({(item["country"], item["ticker"]) for item in active}),
            len(active),
        )
        counts: dict[tuple[str, str], int] = {}
        for item in active:
            key = (item["country"], item["assetType"])
            counts[key] = counts.get(key, 0) + 1
        self.assertEqual(
            counts,
            {
                ("KR", "STOCK"): 2_822,
                ("KR", "ETF"): 1_146,
                ("US", "STOCK"): 50,
                ("US", "ETF"): 50,
            },
        )
        tickers = {(item["country"], item["ticker"]) for item in active}
        for ticker in ("SOXL", "TQQQ", "QLD"):
            self.assertIn(("US", ticker), tickers)

    def test_config_cannot_request_more_than_hard_ceiling(self) -> None:
        config = {
            "schemaVersion": 2,
            "maxInstruments": 1,
            "groups": [
                {
                    "country": "US",
                    "assetType": "STOCK",
                    "selection": "explicit",
                    "tickers": ["AAPL", "MSFT"],
                    "exclude": [],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exceed"):
                load_active_instruments(path, DEFAULT_CATALOG)

    def test_config_rejects_unsupported_schema_version(self) -> None:
        config = {
            "schemaVersion": 1,
            "maxInstruments": 1,
            "groups": [
                {
                    "country": "US",
                    "assetType": "STOCK",
                    "selection": "explicit",
                    "tickers": ["AAPL"],
                    "exclude": [],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "schemaVersion"):
                load_active_instruments(path, DEFAULT_CATALOG)

    def test_explicit_ticker_must_exist_in_matching_catalog_group(self) -> None:
        config = {
            "schemaVersion": 2,
            "maxInstruments": 1,
            "groups": [
                {
                    "country": "US",
                    "assetType": "STOCK",
                    "selection": "explicit",
                    "tickers": ["NOT-A-REAL-TICKER"],
                    "exclude": [],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "absent"):
                load_active_instruments(path, DEFAULT_CATALOG)

    def test_eight_shards_cover_the_universe_once_and_fit_run_limit(
        self,
    ) -> None:
        active = load_active_instruments(
            DEFAULT_ACTIVE_CONFIG,
            DEFAULT_CATALOG,
        )
        shards = [select_shard(active, 8, index) for index in range(8)]
        combined = [
            (item["country"], item["ticker"])
            for shard in shards
            for item in shard
        ]

        self.assertEqual(len(combined), len(active))
        self.assertEqual(len(set(combined)), len(active))
        self.assertLessEqual(
            max(map(len, shards)),
            MAX_INSTRUMENTS_PER_RUN,
        )
        self.assertLessEqual(max(map(len, shards)), 509)


class HistoryPlanningTests(unittest.TestCase):
    def test_new_ticker_requests_one_year_backfill(self) -> None:
        today = date(2026, 7, 20)

        self.assertEqual(
            plan_fetch_ranges(None, today),
            [
                FetchRange(
                    start=today - timedelta(days=ROLLING_WINDOW_DAYS),
                    end=today + timedelta(days=1),
                    purpose="backfill",
                )
            ],
        )

    def test_existing_ticker_gets_increment_and_bounded_gap_repair(
        self,
    ) -> None:
        today = date(2026, 7, 20)
        window_start = today - timedelta(days=ROLLING_WINDOW_DAYS)
        missing = date(2025, 10, 14)
        prices = [
            {"date": value.isoformat(), "close": 100}
            for value in _weekdays(window_start, date(2026, 7, 18))
            if value != missing
        ]
        history = {"prices": prices, "nonTradingDates": []}

        ranges = plan_fetch_ranges(history, today)

        self.assertIn(
            FetchRange(
                start=date(2026, 7, 18),
                end=date(2026, 7, 21),
                purpose="incremental",
            ),
            ranges,
        )
        self.assertIn(
            FetchRange(
                start=missing,
                end=missing + timedelta(days=7),
                purpose="repair",
            ),
            ranges,
        )
        self.assertLessEqual(len(ranges), 2)

    def test_confirmed_non_trading_date_is_not_repaired_again(self) -> None:
        today = date(2026, 7, 20)
        window_start = today - timedelta(days=ROLLING_WINDOW_DAYS)
        holiday = date(2025, 10, 14)
        prices = [
            {"date": value.isoformat(), "close": 100}
            for value in _weekdays(window_start, today + timedelta(days=1))
            if value != holiday
        ]
        history = {
            "prices": prices,
            "nonTradingDates": [holiday.isoformat()],
        }

        ranges = plan_fetch_ranges(history, today)

        self.assertNotIn("repair", {item.purpose for item in ranges})

    def test_current_history_needs_no_duplicate_provider_request(self) -> None:
        today = date(2026, 7, 20)
        history = {
            "prices": [
                {"date": "2026-07-17", "close": 100},
                {"date": "2026-07-20", "close": 101},
            ],
            "nonTradingDates": [],
        }

        self.assertEqual(plan_fetch_ranges(history, today), [])


class RollingHistoryTests(unittest.TestCase):
    def test_merge_deduplicates_overwrites_and_trims_to_one_year(self) -> None:
        today = date(2026, 7, 20)
        old = today - timedelta(days=ROLLING_WINDOW_DAYS + 1)
        retained = today - timedelta(days=10)
        existing = {
            "prices": [
                {"date": old.isoformat(), "close": 10},
                {"date": retained.isoformat(), "close": 20},
            ],
            "nonTradingDates": [],
        }

        result = update_history(
            existing,
            instrument(),
            [
                {"date": retained.isoformat(), "close": 25},
                {"date": today.isoformat(), "close": 30},
            ],
            [
                FetchRange(
                    start=retained,
                    end=today + timedelta(days=1),
                    purpose="incremental",
                )
            ],
            today,
            updated_at="2026-07-20T00:00:00Z",
        )

        self.assertEqual(
            result["prices"],
            [
                {"date": retained.isoformat(), "close": 25.0},
                {"date": today.isoformat(), "close": 30.0},
            ],
        )
        self.assertEqual(result["window"]["days"], ROLLING_WINDOW_DAYS)
        self.assertEqual(result["latest"]["close"], 30.0)

    def test_successful_repair_records_old_empty_weekdays_for_gap_scans(
        self,
    ) -> None:
        today = date(2026, 7, 20)
        empty_weekday = date(2025, 8, 4)
        result = update_history(
            None,
            instrument(),
            [{"date": date(2025, 8, 5).isoformat(), "close": 100}],
            [
                FetchRange(
                    start=empty_weekday,
                    end=date(2025, 8, 6),
                    purpose="repair",
                )
            ],
            today,
        )

        self.assertIn(
            empty_weekday.isoformat(),
            result["nonTradingDates"],
        )


class R2HistoryTests(unittest.TestCase):
    def test_history_is_stored_per_country_and_ticker_as_gzip(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeClient:
            def put_object(self, **kwargs: object) -> None:
                calls.append(kwargs)

        item = instrument("BRK.B")
        store = R2HistoryStore(FakeClient(), "prices", "market-data")
        history = {"schemaVersion": 1, "prices": []}

        store.save(item, history)

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0]["Key"],
            "market-data/history/US/BRK.B.json.gz",
        )
        self.assertEqual(calls[0]["ContentEncoding"], "gzip")
        self.assertTrue(bytes(calls[0]["Body"]).startswith(b"\x1f\x8b"))
        self.assertEqual(
            history_object_key(item, "/market-data/"),
            "market-data/history/US/BRK.B.json.gz",
        )

    def test_existing_gzip_history_is_loaded(self) -> None:
        saved: dict[str, object] = {}

        class FakeClient:
            def put_object(self, **kwargs: object) -> None:
                saved.update(kwargs)

            def get_object(self, **kwargs: object) -> dict[str, object]:
                return {"Body": io.BytesIO(bytes(saved["Body"]))}

        client = FakeClient()
        store = R2HistoryStore(client, "prices", "market-data")
        expected = {"schemaVersion": 1, "prices": [{"date": "2026-07-17"}]}
        store.save(instrument(), expected)

        self.assertEqual(store.load(instrument()), expected)

    def test_run_summary_is_persisted_with_final_uploaded_state(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeClient:
            def put_object(self, **kwargs: object) -> None:
                calls.append(kwargs)

        store = R2HistoryStore(FakeClient(), "prices", "market-data")
        summary: dict[str, object] = {"runId": "run-1", "r2": {}}

        keys = store.save_run_summary(
            "run-1",
            "2026-07-20",
            summary,
        )

        self.assertEqual(len(calls), 2)
        self.assertEqual(
            keys,
            {
                "run": "market-data/runs/2026-07-20/run-1.json",
                "latestRun": "market-data/latest/run-summary.json",
            },
        )
        persisted = json.loads(bytes(calls[0]["Body"]).decode("utf-8"))
        self.assertEqual(persisted["r2"]["status"], "uploaded")
        self.assertEqual(persisted["r2"]["run"], keys["run"])

    def test_shard_summaries_do_not_race_on_the_latest_key(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeClient:
            def put_object(self, **kwargs: object) -> None:
                calls.append(kwargs)

        store = R2HistoryStore(FakeClient(), "prices", "market-data")
        summary: dict[str, object] = {
            "runId": "run-1",
            "shard": {"count": 8, "index": 3},
            "r2": {},
        }

        keys = store.save_run_summary(
            "run-1",
            "2026-07-20",
            summary,
        )

        self.assertEqual(
            keys["latestRun"],
            "market-data/latest/shards/3.json",
        )

    def test_shard_quote_snapshot_keeps_two_native_closes(self) -> None:
        calls: list[dict[str, object]] = []

        class MissingObjectError(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        class FakeClient:
            def get_object(self, **kwargs: object) -> dict[str, object]:
                raise MissingObjectError()

            def put_object(self, **kwargs: object) -> None:
                calls.append(kwargs)

        store = R2HistoryStore(FakeClient(), "prices", "market-data")
        history = update_history(
            None,
            instrument("AAPL"),
            [
                {"date": "2026-07-17", "close": 210},
                {"date": "2026-07-20", "close": 215},
            ],
            [
                FetchRange(
                    start=date(2026, 7, 17),
                    end=date(2026, 7, 21),
                    purpose="backfill",
                )
            ],
            date(2026, 7, 20),
        )
        quote = quote_from_history(history)
        assert quote is not None

        key, count = store.save_shard_quotes(
            2,
            8,
            [instrument("AAPL")],
            [quote],
            "2026-07-20T07:30:00Z",
        )

        self.assertEqual(
            key,
            "market-data/latest/quotes/shards/2.json.gz",
        )
        self.assertEqual(
            shard_quote_object_key(2, "market-data"),
            key,
        )
        self.assertEqual(count, 1)
        payload = json.loads(
            gzip.decompress(bytes(calls[0]["Body"]))
            .decode("utf-8")
        )
        self.assertEqual(payload["quotes"][0]["currency"], "USD")
        self.assertEqual(
            payload["quotes"][0]["closes"],
            [
                {"date": "2026-07-17", "close": 210.0},
                {"date": "2026-07-20", "close": 215.0},
            ],
        )


class TimeBudgetTests(unittest.TestCase):
    def test_soft_budget_stops_before_starting_remaining_tickers(self) -> None:
        class FakeClock:
            value = 0.0

            def __call__(self) -> float:
                return self.value

        class SlowProvider:
            def __init__(self, clock: FakeClock) -> None:
                self.clock = clock
                self.calls = 0

            def fetch(
                self,
                item: dict[str, str],
                start: date,
                end: date,
            ) -> list[dict[str, object]]:
                self.calls += 1
                self.clock.value += 11
                return [{"date": end.__sub__(timedelta(days=1)).isoformat(),
                         "close": 100}]

        clock = FakeClock()
        provider = SlowProvider(clock)
        store = MemoryHistoryStore()
        stats, failures, quotes = collect_active_histories(
            [instrument("AAA"), instrument("BBB")],
            store,
            provider,
            today=date(2026, 7, 20),
            soft_time_budget_seconds=10,
            retries=0,
            request_delay=0,
            clock=clock,
            sleep=lambda seconds: None,
        )

        self.assertEqual(provider.calls, 1)
        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(stats["skippedForTimeBudget"], 1)
        self.assertTrue(stats["softTimeBudgetReached"])
        self.assertEqual(failures, [])
        self.assertEqual(len(quotes), 1)

    def test_circuit_breaker_stops_after_consecutive_failures(self) -> None:
        class BrokenProvider:
            def fetch(
                self,
                item: dict[str, str],
                start: date,
                end: date,
            ) -> list[dict[str, object]]:
                raise RuntimeError("provider unavailable")

        items = [instrument(f"FAIL{index}") for index in range(5)]
        stats, failures, quotes = collect_active_histories(
            items,
            MemoryHistoryStore(),
            BrokenProvider(),
            today=date(2026, 7, 20),
            soft_time_budget_seconds=60,
            retries=0,
            request_delay=0,
            max_consecutive_failures=2,
            sleep=lambda seconds: None,
        )

        self.assertEqual(stats["processed"], 2)
        self.assertEqual(stats["failed"], 2)
        self.assertEqual(stats["skippedForCircuitBreaker"], 3)
        self.assertTrue(stats["circuitBreakerReached"])
        self.assertEqual(len(failures), 2)
        self.assertEqual(quotes, [])


def _weekdays(start: date, end_exclusive: date) -> list[date]:
    result: list[date] = []
    current = start
    while current < end_exclusive:
        if current.weekday() < 5:
            result.append(current)
        current += timedelta(days=1)
    return result


if __name__ == "__main__":
    unittest.main()
