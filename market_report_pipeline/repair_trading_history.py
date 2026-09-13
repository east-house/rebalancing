"""Explicit, archived revision of a ledger using audited common input data."""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile

import pandas as pd

from . import trading_replay as replay
from . import trading_observations as observations
from .io_utils import write_json
from .report_store import ReportStore, encode
from .report_time import expected_market_date, korean_today


class MemoryStore:
    """Local preparation uses the same staging interface, with no remote writes."""
    def __init__(self):
        self.objects = {}
    def read(self, key):
        return self.objects.get(key)
    def load(self, key):
        raw = self.read(key)
        return json.loads(raw) if raw is not None else None
    def stage(self, key, value, content_type="application/json"):
        self.objects[key] = value if isinstance(value, bytes) else encode(value)


def prepare(inputs: Path, as_of: pd.Timestamp, output: Path):
    if as_of > pd.Timestamp(korean_today()):
        raise ValueError("Future as-of date")
    end = expected_market_date(as_of)
    catalog = json.loads((inputs / "catalog.json").read_text(encoding="utf-8"))
    paths = [inputs / name for name in ("cache.parquet", "downloaded.parquet", "fisv.parquet") if (inputs / name).exists()]
    prices, provenance = replay.merge_sources(paths)
    provenance["catalogSha256"] = replay.digest(inputs / "catalog.json")
    start = pd.Timestamp(replay.engine.CONFIG["strategy"]["initial_signal_date"])
    panel, audit = replay.prepare_panel(prices, catalog, start, end)
    audit["provenance"] = provenance
    audit["evidence"] = catalog.get("evidence", {})
    audit["indicatorValidation"] = "passed"
    reference = replay.generate(prices, catalog, start, end, provenance)[str(start.date())]
    store = MemoryStore()
    store.stage(observations.INDEX, {"schemaVersion": 1, "audit": audit, "sessions": {},
                                     "baselineKind": "reconstructed-common-input"})
    reports = []
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        for day in panel.calendar[panel.calendar >= start]:
            visible = observations.slice_panel(panel, day)
            quality = {"marketDate": str(day.date()), "universeCount": len(panel.universe),
                       "latestCoverage": 1.0, "missingSymbols": [], "snapshot": panel.snapshot_path.name}
            result = replay.engine.run(day + pd.offsets.Day(1), Path(directory), market_input=(visible, quality))
            report = result["reports"][-1]
            reports.append(deepcopy(report))
            store.stage(f"trading-test-reports/reports/{report['reportDate']}.json", report)
            observations.stage_observation(store, visible, day, quality, kind="reconstructed-common-input")
        state = result["state"]
    # Independent sequential forward runs must match both replay implementations.
    for left, right in zip(reports, reference["reports"]):
        for field in observations.COMPARISON_FIELDS:
            observations.assert_equal(left[field], right[field], f"{left['marketDate']}.{field}")
    bundles, index = observations.generate_observed(store)
    for report in reports:
        write_json(report, output / f"{report['reportDate']}.json")
    write_json(state, output / "state.json")
    write_json({"passed": True, "sessions": len(reports), "start": str(start.date()),
                "end": str(end.date()), "comparedFields": observations.COMPARISON_FIELDS,
                "provenance": provenance}, output / "verification.json")
    return store, state, reports, bundles


def publish(prepared, as_of, *, store=None):
    source, state, reports, bundles = prepared
    target = store if store is not None else ReportStore.from_environment("trading")
    current = target.load("trading-test-reports/state/latest.json")
    end = reports[-1]["marketDate"]
    if current and current["lastProcessedMarketDate"] > end:
        raise ValueError("Repair cannot move the current ledger backwards")
    previous = target.manifest.get("releaseId")
    baseline_id = hashlib.sha256(encode({"provenance": source.load(observations.INDEX)["audit"]["provenance"],
                                         "end": end, "strategy": replay.engine.CONFIG})).hexdigest()
    if current and current.get("reconciliation", {}).get("baselineId") == baseline_id:
        return target.manifest
    # The complete previous manifest and its immutable objects remain readable.
    target.stage(f"trading-test-reports/revisions/{previous or 'legacy'}.json", deepcopy(target.manifest))
    if current:
        target.stage(f"trading-test-reports/state/archive/{hashlib.sha256(encode(current)).hexdigest()}.json", current)
    revision = {"kind": "reconstructed-common-input", "baselineId": baseline_id,
                "previousReleaseId": previous, "reason": "Align forward and replay inputs after verified historical mismatch"}
    state = {**state, "reconciliation": revision}
    revised = []
    for original in reports:
        report = deepcopy(original)
        report["reconciliation"] = revision
        report["disclaimer"] = "입력 불일치를 수정하기 위해 검증된 공통 자료로 재구성한 가상계좌입니다. 이전 원본은 별도 보존되어 있으며 당시 실제 실행 결과를 뜻하지 않습니다."
        revised.append(report)
    for key, raw in source.objects.items():
        if "/reports/" not in key:
            target.stage(key, raw, "application/octet-stream" if key.endswith(".parquet") else "application/json")
    for report in revised:
        target.stage(f"trading-test-reports/reports/{report['reportDate']}.json", report)
    index = replay.engine._merge_index(target.load("trading-test-reports/index.json"), revised)
    target.stage("trading-test-reports/index.json", index)
    target.stage("trading-test-reports/latest.json", revised[-1])
    target.stage("trading-test-reports/state/latest.json", state)
    # Verify against exactly the staged regular reports before the atomic commit.
    observations.generate_observed(target)
    return target.commit(job_date=str(as_of.date()), details={"reconciliation": revision})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--output", type=Path, default=Path("action-output/history-repair"))
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    prepared = prepare(args.inputs, pd.Timestamp(args.as_of), args.output)
    if args.publish:
        manifest = publish(prepared, pd.Timestamp(args.as_of))
        write_json({"releaseId": manifest["releaseId"]}, args.output / "publication.json")
    print(json.dumps({"passed": True, "sessions": len(prepared[2]), "published": args.publish}))


if __name__ == "__main__":
    main()
