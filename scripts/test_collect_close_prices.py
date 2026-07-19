from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.collect_close_prices import (
    DEFAULT_CATALOG,
    load_catalog,
    select_instruments,
    upload_to_r2,
    write_outputs,
)


class CatalogSelectionTests(unittest.TestCase):
    def test_all_sample_contains_both_countries_and_asset_types(self) -> None:
        catalog = load_catalog(DEFAULT_CATALOG)
        selected = select_instruments(catalog, "ALL", 10)

        self.assertEqual(len(selected), 10)
        self.assertEqual({item["country"] for item in selected}, {"KR", "US"})
        self.assertEqual(
            {item["assetType"] for item in selected},
            {"STOCK", "ETF"},
        )
        self.assertIn("005930", {item["ticker"] for item in selected})
        self.assertIn("AAPL", {item["ticker"] for item in selected})

    def test_test_limit_is_enforced(self) -> None:
        catalog = load_catalog(DEFAULT_CATALOG)
        with self.assertRaisesRegex(ValueError, "limited to"):
            select_instruments(catalog, "ALL", 101)


class R2UploadTests(unittest.TestCase):
    def test_upload_uses_test_prefix_and_writes_four_objects(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeS3Client:
            def put_object(self, **kwargs: object) -> None:
                calls.append(kwargs)

        fake_boto3 = SimpleNamespace(
            client=lambda *args, **kwargs: FakeS3Client()
        )
        summary = {
            "runId": "test-run",
            "requested": 1,
            "succeeded": 1,
            "failed": 0,
            "durationSeconds": 0.1,
            "r2": {"status": "uploading"},
        }
        quote_payload = {"meta": {}, "quotes": [{"ticker": "AAPL"}]}
        failure_payload = {"meta": {}, "failures": []}
        environment = {
            "R2_ACCOUNT_ID": "account",
            "R2_ACCESS_KEY_ID": "access",
            "R2_SECRET_ACCESS_KEY": "secret",
            "R2_BUCKET_NAME": "quotes",
        }

        with tempfile.TemporaryDirectory() as directory:
            paths = write_outputs(
                Path(directory),
                quote_payload,
                failure_payload,
                summary,
            )
            with (
                patch.dict(sys.modules, {"boto3": fake_boto3}),
                patch.dict(os.environ, environment, clear=False),
            ):
                keys = upload_to_r2(
                    paths,
                    summary=summary,
                    run_id="test-run",
                    prefix="test",
                    run_date="2026-07-19",
                )

        self.assertEqual(len(calls), 4)
        self.assertEqual(keys["bucket"], "quotes")
        self.assertEqual(
            keys["quotes"],
            "test/quotes/2026-07-19/test-run/quotes.json.gz",
        )
        self.assertEqual(keys["latest"], "test/latest/quotes.json.gz")
        self.assertEqual(summary["r2"]["status"], "uploaded")


if __name__ == "__main__":
    unittest.main()
