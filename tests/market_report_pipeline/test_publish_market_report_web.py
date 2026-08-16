from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pandas as pd


from market_report_pipeline import publish_market_report_web as MODULE


def test_report_display_date_uses_run_date_including_weekend() -> None:
    assert MODULE.report_display_date({"as_of": "2026-08-16 00:00:00"}) == pd.Timestamp(
        "2026-08-16"
    )


def test_update_index_replaces_same_display_date_and_sorts(tmp_path: Path) -> None:
    target = tmp_path / "market-reports"
    target.mkdir()
    (target / "index.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "reports": [
                    {"displayDate": "2026-08-14", "marketDate": "2026-08-13"},
                    {"displayDate": "2026-08-17", "marketDate": "old"},
                ],
            }
        ),
        encoding="utf-8",
    )
    bundle = {
        "displayDate": "2026-08-17",
        "marketDate": "2026-08-14",
        "generatedAt": "2026-08-16T00:17:00+09:00",
        "summary": {
            "state": {"state": "상승 확산", "risk_level": "낮음"},
            "topSector": {"sector_display": "건강관리 (Health Care)"},
            "topTheme": {"theme": "사이버보안"},
        },
    }

    result = MODULE.update_index(target, bundle)

    assert [item["displayDate"] for item in result["reports"]] == ["2026-08-17", "2026-08-14"]
    assert result["reports"][0]["marketDate"] == "2026-08-14"
    assert result["reports"][0]["topTheme"] == "사이버보안"


def test_update_index_removes_report_generated_before_its_display_date(tmp_path: Path) -> None:
    target = tmp_path / "market-reports"
    target.mkdir()
    (target / "index.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "reports": [
                    {
                        "displayDate": "2026-08-17",
                        "marketDate": "2026-08-14",
                        "generatedAt": "2026-08-16T02:52:46+09:00",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    bundle = {
        "displayDate": "2026-08-16",
        "marketDate": "2026-08-14",
        "generatedAt": "2026-08-16T07:40:00+09:00",
        "summary": {
            "state": {"state": "상승 확산", "risk_level": "낮음"},
            "topSector": {},
            "topTheme": {},
        },
    }

    result = MODULE.update_index(target, bundle)

    assert [item["displayDate"] for item in result["reports"]] == ["2026-08-16"]


def test_hydrate_index_restores_durable_r2_history(tmp_path: Path, monkeypatch) -> None:
    durable = {
        "schemaVersion": 2,
        "latestDisplayDate": "2026-08-17",
        "reports": [{"displayDate": "2026-08-17", "marketDate": "2026-08-14"}],
    }

    class FakeClient:
        def get_object(self, **_kwargs):
            return {"Body": BytesIO(json.dumps(durable).encode("utf-8"))}

    monkeypatch.setattr(MODULE, "_r2_client", lambda: FakeClient())

    assert MODULE.hydrate_index_from_r2(tmp_path, "bucket") is True
    restored = json.loads(
        (tmp_path / "public" / "data" / "market-reports" / "index.json").read_text(encoding="utf-8")
    )
    assert restored["reports"] == durable["reports"]


def test_upload_r2_publishes_index_after_immutable_assets(tmp_path: Path, monkeypatch) -> None:
    report = tmp_path / "2026-08-17.json"
    report.write_text("{}", encoding="utf-8")
    report.with_suffix(".html").write_text("<html></html>", encoding="utf-8")
    report.with_suffix(".png").write_bytes(b"png")
    index = tmp_path / "index.json"
    index.write_text("{}", encoding="utf-8")

    uploaded: list[str] = []
    sizes: dict[str, int] = {}

    class FakeClient:
        def put_object(self, *, Key, Body, **_kwargs):
            uploaded.append(Key)
            sizes[Key] = len(Body)

        def head_object(self, *, Key, **_kwargs):
            return {"ContentLength": sizes[Key]}

    monkeypatch.setattr(MODULE, "_r2_client", lambda: FakeClient())

    MODULE.upload_r2(report, index, "bucket")

    assert uploaded[-1] == "market-reports/index.json"
    assert "market-reports/2026-08-17.png" in uploaded
