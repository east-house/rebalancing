import copy
import json
from collections import Counter

import pandas as pd
import pytest
import requests

from market_report_pipeline import support
from market_report_pipeline import us_market_report as market


def response(day="2026-09-08", missing=None):
    quote = {key: [100.0] for key in support.PRICE_COLUMNS}
    if missing:
        quote[missing] = [None]
    payload = {"chart": {"result": [{
        "timestamp": [int(pd.Timestamp(f"{day}T13:30:00Z").timestamp())],
        "indicators": {"quote": [quote]},
    }]}}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return copy.deepcopy(payload)

    return Response()


def install_responses(monkeypatch, responses):
    queue = iter(responses)
    calls, sleeps = [], []

    def get(url, **kwargs):
        calls.append((url, copy.deepcopy(kwargs)))
        value = next(queue)
        if isinstance(value, Exception):
            raise value
        return value

    monkeypatch.setattr(support.requests, "get", get)
    monkeypatch.setattr(support.time, "sleep", sleeps.append)
    monkeypatch.setattr(support, "_retry_delay_seconds", lambda *_: 0.5)
    return calls, sleeps


def download(**kwargs):
    return support._download_yahoo_frame("AAPL", pd.Timestamp("2026-09-01"), pd.Timestamp("2026-09-09"), timeout=20, max_retries=4, **kwargs)


@pytest.mark.parametrize("first", [response("2026-09-04"), response(missing="open"), response("2026-09-09")])
def test_retry_missing_incomplete_or_future_only_data_then_accept_complete_quote(monkeypatch, first):
    calls, sleeps = install_responses(monkeypatch, [first, response()])
    result = download(expected_latest=pd.Timestamp("2026-09-08"))
    assert result.date.max() == pd.Timestamp("2026-09-08")
    assert result.close.iloc[0] == 100.0  # Missing adjusted-close still preserves valid raw OHLC.
    assert result.attrs["collection_attempts"] == 2
    assert len(calls) == 2 and sleeps == [0.5]
    assert calls[0][1]["params"] == calls[1][1]["params"]
    assert "query2" in calls[0][0] and "query1" in calls[1][0]


def test_network_errors_and_stale_quotes_share_one_attempt_budget(monkeypatch):
    calls, sleeps = install_responses(monkeypatch, [requests.ConnectionError("offline"), response("2026-09-04"), requests.Timeout("timeout"), response(missing="high")])
    with pytest.raises(RuntimeError, match="attempt=4/4") as caught:
        download(expected_latest=pd.Timestamp("2026-09-08"))
    assert isinstance(caught.value.__cause__, support.PriceDataNotReady)
    assert len(calls) == 4 and len(sleeps) == 3
    assert "missing_ohlc=['high']" in str(caught.value)


def test_shared_adapter_keeps_legacy_behavior_without_expected_session(monkeypatch):
    calls, sleeps = install_responses(monkeypatch, [response("2026-09-04")])
    result = download()
    assert result.date.max() == pd.Timestamp("2026-09-04")
    assert len(calls) == 1 and sleeps == []


def test_fresh_http_response_does_not_retry(monkeypatch):
    calls, sleeps = install_responses(monkeypatch, [response()])
    download(expected_latest=pd.Timestamp("2026-09-08"))
    assert len(calls) == 1 and sleeps == []


@pytest.mark.parametrize("recovers", [True, False])
def test_collector_retries_only_missing_symbol_and_preserves_cache_on_exhaustion(tmp_path, monkeypatch, recovers):
    cache = tmp_path / "cache"
    cache.mkdir()
    for ticker, day in [("IVV", "2026-09-08"), ("AAPL", "2026-09-04")]:
        pd.DataFrame({"date": [pd.Timestamp(day)], "ticker": [ticker], "provider_symbol": [ticker],
                      "open": [100.0], "high": [101.0], "low": [99.0], "close": [100.0], "volume": [1000.0]}).to_parquet(cache / f"{ticker}.parquet", index=False)
    before = (cache / "AAPL.parquet").read_bytes()
    calls, sleeps = install_responses(monkeypatch, [response("2026-09-04")] + ([response()] if recovers else [response("2026-09-04")] * 3))
    monkeypatch.setattr(market, "STOCK_CACHE", cache)
    settings = market.MarketRunSettings(pd.Timestamp("2026-09-09"), pd.Timestamp("2026-09-01"), tmp_path / "output", tmp_path / "config")
    config = {"data": {"request_workers": 1, "request_timeout_seconds": 20, "max_retries": 4,
                       "minimum_fresh_symbols": 2, "cache_overlap_days": 10}, "indices": {"S&P 500": "IVV"}}
    if recovers:
        _, audit = market.collect_context_prices(["AAPL", "IVV"], settings, config)
        assert audit["fresh_symbols"] == 2
        assert audit["failures"] == []
    else:
        with pytest.raises(RuntimeError, match="freshness validation failed"):
            market.collect_context_prices(["AAPL", "IVV"], settings, config)
        audit = json.loads((settings.output_dir / "price_collection_audit.json").read_text())
        assert audit["fresh_symbols"] == 1 and audit["required_fresh_symbols"] == 2
        assert "attempt=4/4" in audit["failures"][0]["error"]
        assert (cache / "AAPL.parquet").read_bytes() == before
    assert Counter(url.rsplit("/", 1)[1] for url, _ in calls) == {"AAPL": 2 if recovers else 4}
    assert len(sleeps) == (1 if recovers else 3)
