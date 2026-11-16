from datetime import datetime, timezone
import json

import numpy as np
import pandas as pd
import pytest

from market_report_pipeline import portfolio_evening as evening, report_time
from market_report_pipeline.portfolio_strategy_inputs import RETURN_LOOKBACK, compute_strategy_inputs
from market_report_pipeline.report_store import ReportStore
from test_report_integrity import FakeS3


def _closes(days=300):
    index = pd.bdate_range("2025-06-02", periods=days)
    rng = np.random.default_rng(0)
    data = {t: 100 * np.cumprod(1 + rng.normal(0.0005, 0.01, days)) for t in ["IVV", "AAA", "BBB", "CCC"]}
    return pd.DataFrame(data, index=index)


def test_inputs_use_only_data_through_signal_session():
    closes = _closes()
    signal = closes.index[-20]
    candidates = [{"ticker": "IVV", "rank": 1}, {"ticker": "AAA", "rank": 2}, {"ticker": "BBB", "rank": 3}, {"ticker": "CCC", "rank": 4}]
    inputs = compute_strategy_inputs(closes, signal, candidates, {"AAA": "Information Technology"}, report_date="2026-08-03", source="test")
    history = closes.loc[:signal]
    assert inputs["last_return_date"] == str(signal.date())
    assert len(inputs["returns"]["IVV"]) == RETURN_LOOKBACK
    assert inputs["returns"]["AAA"][-1] == pytest.approx(history["AAA"].iloc[-1] / history["AAA"].iloc[-2] - 1, abs=1e-7)
    assert inputs["tickers"]["AAA"]["mom_12_1"] == pytest.approx(history["AAA"].iloc[-22] / history["AAA"].iloc[-253] - 1)
    assert inputs["tickers"]["AAA"]["gics_sector"] == "Information Technology"
    assert inputs["tickers"]["BBB"]["gics_sector"] is None
    # Changing prices after the signal session must not change the inputs.
    later = closes.copy(); later.loc[later.index > signal] *= 3
    assert compute_strategy_inputs(later, signal, candidates, {"AAA": "Information Technology"}, report_date="2026-08-03", source="test") == inputs


def test_missing_signal_session_is_rejected():
    closes = _closes()
    with pytest.raises(ValueError, match="completed US session"):
        compute_strategy_inputs(closes, closes.index[-1] + pd.Timedelta(days=1), [], {}, report_date="x", source="t")


def test_evening_publication_stores_inputs_beside_unchanged_report(monkeypatch):
    now = datetime(2026, 9, 14, 10, 15, tzinfo=timezone.utc)
    monkeypatch.setattr(report_time, "utc_now", lambda: now)
    store = ReportStore(FakeS3(), "b", "portfolio")
    payload = {"report_date_kst": "2026-09-14", "signal_market_date": "2026-09-11", "proposed_execution_date": "2026-09-14", "generated_at": now.isoformat()}
    inputs = {"report_date_kst": "2026-09-14", "signal_market_date": "2026-09-11", "schema_version": 1}
    evening.publish_portfolio(store, "2026-09-14", dict(payload), inputs)
    assert store.load("portfolio-reports/strategy-inputs/2026-09-14.json") == inputs
    other = ReportStore(FakeS3(), "b", "portfolio")
    evening.publish_portfolio(other, "2026-09-14", dict(payload))
    assert other.load("portfolio-reports/2026-09-14.json") == store.load("portfolio-reports/2026-09-14.json")
    assert other.load("portfolio-reports/strategy-inputs/2026-09-14.json") is None


def test_price_refresh_records_unavailable_symbol_without_aborting(monkeypatch, tmp_path):
    from market_report_pipeline import repair_portfolio_history
    from market_report_pipeline.portfolio_strategy_inputs import _refresh_prices

    def fake_fill(symbols, days, output):
        (symbol,) = symbols
        if symbol == "KVUE":
            raise RuntimeError("Yahoo KVUE 수집 실패: 'open'")
        return [{"symbol": symbol, "missingBefore": [], "missingAfter": []}]

    monkeypatch.setattr(repair_portfolio_history, "fill_price_gaps", fake_fill)
    failures = _refresh_prices({"IVV", "KVUE", "AAA"}, ["2026-09-14"], tmp_path)
    assert list(failures) == ["KVUE"] and "KVUE" in failures["KVUE"]
    audit = json.loads((tmp_path / "historical-price-gaps.json").read_text(encoding="utf-8"))
    assert sorted(row["symbol"] for row in audit["audit"]) == ["AAA", "IVV"]
    assert audit["failures"] == failures
