from __future__ import annotations

import unittest

from scripts.aggregate_latest_quotes import (
    build_combined_payload,
    combined_object_key,
)


class LatestQuoteAggregationTests(unittest.TestCase):
    def test_combines_shards_and_keeps_recent_native_closes(self) -> None:
        payload = build_combined_payload(
            [
                {
                    "shard": {"count": 2, "index": 0},
                    "expectedQuoteCount": 1,
                    "quotes": [
                        {
                            "ticker": "005930",
                            "name": "삼성전자",
                            "country": "KR",
                            "assetType": "STOCK",
                            "currency": "KRW",
                            "closes": [
                                {"date": "2026-07-17", "close": 90000},
                                {"date": "2026-07-20", "close": 91000},
                            ],
                        }
                    ],
                },
                {
                    "shard": {"count": 2, "index": 1},
                    "expectedQuoteCount": 1,
                    "quotes": [
                        {
                            "ticker": "AAPL",
                            "name": "Apple Inc.",
                            "country": "US",
                            "assetType": "STOCK",
                            "currency": "USD",
                            "closes": [
                                {"date": "2026-07-17", "close": 325},
                                {"date": "2026-07-20", "close": 330},
                            ],
                        }
                    ],
                },
            ],
            {
                "pair": "USD/KRW",
                "closes": [
                    {"date": "2026-07-17", "close": 1380},
                    {"date": "2026-07-20", "close": 1390},
                ],
            },
            "2026-07-20T07:30:00Z",
            2,
        )

        self.assertTrue(payload["complete"])
        self.assertEqual(payload["availableShards"], [0, 1])
        self.assertEqual(payload["quoteCount"], 2)
        self.assertEqual(payload["quotes"][1]["ticker"], "AAPL")
        self.assertEqual(
            payload["fx"]["usdKrw"]["closes"][-1]["close"],
            1390.0,
        )

    def test_combined_object_uses_the_collection_prefix(self) -> None:
        self.assertEqual(
            combined_object_key("/market-data/"),
            "market-data/latest/quotes/all.json.gz",
        )

    def test_marks_a_partial_first_run_as_incomplete(self) -> None:
        payload = build_combined_payload(
            [
                {
                    "shard": {"count": 1, "index": 0},
                    "expectedQuoteCount": 2,
                    "quotes": [
                        {
                            "ticker": "005930",
                            "name": "삼성전자",
                            "country": "KR",
                            "assetType": "STOCK",
                            "currency": "KRW",
                            "closes": [
                                {"date": "2026-07-20", "close": 91000},
                            ],
                        }
                    ],
                }
            ],
            {
                "closes": [
                    {"date": "2026-07-20", "close": 1390},
                ],
            },
            "2026-07-20T07:30:00Z",
            1,
        )

        self.assertFalse(payload["complete"])
        self.assertEqual(payload["incompleteShards"], [0])


if __name__ == "__main__":
    unittest.main()
