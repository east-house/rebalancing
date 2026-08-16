"""Convert a generated market report into web JSON and optionally publish it to R2."""

from __future__ import annotations

import argparse
import json
import math
import os
from datetime import date, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


SCHEMA_VERSION = 2
MAX_INDEX_REPORTS = 520


def report_display_date(manifest: dict[str, Any]) -> pd.Timestamp:
    """Use the requested Korean run date as the report's display date."""

    value = manifest.get("as_of")
    if value is None:
        raise ValueError("market_report_manifest.json is missing as_of")
    result = pd.Timestamp(value)
    if pd.isna(result):
        raise ValueError("market_report_manifest.json has an invalid as_of")
    result = result.normalize()
    if result.weekday() >= 5:
        raise ValueError(f"Weekend reports are not published: {result:%Y-%m-%d}")
    return result


def _clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return pd.Timestamp(value).isoformat()
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if not math.isfinite(float(value)) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if value is pd.NA:
        return None
    return value


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def _records(path: Path) -> list[dict[str, Any]]:
    frame = pd.read_csv(path)
    frame = frame.replace({np.nan: None})
    return _clean(frame.to_dict(orient="records"))


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(_clean(value), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def build_web_bundle(source: Path) -> dict[str, Any]:
    required = [
        "market_state.json",
        "market_overview.csv",
        "sector_leadership.csv",
        "theme_leadership.csv",
        "market_leaders.csv",
        "macro_dashboard.csv",
        "economic_events_today.csv",
        "economic_events_upcoming.csv",
        "market_news.csv",
        "macro_axes.csv",
        "news_clusters.csv",
        "transmission_signals.csv",
        "MARKET_REPORT.html",
        "market_dashboard.png",
        "market_data_quality.json",
        "market_report_manifest.json",
    ]
    missing = [name for name in required if not (source / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing market-report artifacts: {', '.join(missing)}")

    state = _read_json(source / "market_state.json")
    quality = _read_json(source / "market_data_quality.json")
    manifest = _read_json(source / "market_report_manifest.json")
    overview = _records(source / "market_overview.csv")
    sectors = _records(source / "sector_leadership.csv")
    themes = _records(source / "theme_leadership.csv")
    leaders = _records(source / "market_leaders.csv")
    macro = _records(source / "macro_dashboard.csv")
    today_events = _records(source / "economic_events_today.csv")
    upcoming_events = _records(source / "economic_events_upcoming.csv")
    news = _records(source / "market_news.csv")
    macro_axes = _records(source / "macro_axes.csv")
    news_clusters = _records(source / "news_clusters.csv")
    transmissions = _records(source / "transmission_signals.csv")

    market_date = pd.Timestamp(state["market_date"]).normalize()
    display_date = report_display_date(manifest)
    indices = [row for row in overview if row.get("category") == "주가지수"]
    risks = [row for row in overview if row.get("category") == "위험·자산"]
    top_sector = sectors[0] if sectors else None
    weakest_sector = sectors[-1] if sectors else None
    top_theme = themes[0] if themes else None

    return _clean(
        {
            "schemaVersion": SCHEMA_VERSION,
            "displayDate": display_date.strftime("%Y-%m-%d"),
            "marketDate": market_date.strftime("%Y-%m-%d"),
            "generatedAt": manifest.get("generated_at"),
            "purpose": "market intelligence only; no portfolio or orders",
            "dashboardImage": f"/api/market-reports/{display_date:%Y-%m-%d}/dashboard",
            "summary": {
                "state": state,
                "topSector": top_sector,
                "weakestSector": weakest_sector,
                "topTheme": top_theme,
            },
            "indices": indices,
            "risks": risks,
            "sectors": sectors,
            "themes": themes,
            "leaders": leaders,
            "macro": macro,
            "todayEvents": today_events,
            "upcomingEvents": upcoming_events,
            "news": news,
            "macroAxes": macro_axes,
            "newsClusters": news_clusters,
            "transmissions": transmissions,
            "quality": quality,
        }
    )


def update_index(target_dir: Path, bundle: dict[str, Any]) -> dict[str, Any]:
    index_path = target_dir / "index.json"
    if index_path.exists():
        index = _read_json(index_path)
    else:
        index = {"schemaVersion": SCHEMA_VERSION, "reports": []}
    existing = index.get("reports", [])
    if not isinstance(existing, list):
        existing = []
    valid_existing = []
    for item in existing:
        display_date = str(item.get("displayDate", ""))
        generated_at = item.get("generatedAt")
        if display_date and generated_at:
            generated = pd.Timestamp(generated_at)
            if generated.tzinfo is not None:
                generated = generated.tz_convert("Asia/Seoul")
            if generated.strftime("%Y-%m-%d") < display_date:
                continue
        valid_existing.append(item)
    state = bundle["summary"]["state"]
    top_sector = bundle["summary"].get("topSector") or {}
    top_theme = bundle["summary"].get("topTheme") or {}
    entry = {
        "displayDate": bundle["displayDate"],
        "marketDate": bundle["marketDate"],
        "generatedAt": bundle["generatedAt"],
        "state": state.get("state"),
        "riskLevel": state.get("risk_level"),
        "topSector": top_sector.get("sector_display") or top_sector.get("sector"),
        "topTheme": top_theme.get("theme"),
    }
    reports = [
        item for item in valid_existing if item.get("displayDate") != bundle["displayDate"]
    ]
    reports.append(entry)
    reports = sorted(reports, key=lambda item: str(item.get("displayDate", "")), reverse=True)[
        :MAX_INDEX_REPORTS
    ]
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": bundle["generatedAt"],
        "latestDisplayDate": reports[0]["displayDate"],
        "reports": reports,
    }
    _write_json_atomic(index_path, result)
    return result


def publish_local(source: Path, project_root: Path) -> tuple[Path, Path, dict[str, Any]]:
    bundle = build_web_bundle(source)
    target_dir = project_root / "public" / "data" / "market-reports"
    report_path = target_dir / f"{bundle['displayDate']}.json"
    _write_json_atomic(report_path, bundle)
    html_path = target_dir / f"{bundle['displayDate']}.html"
    html_temporary = html_path.with_name(f".{html_path.name}.tmp")
    html_temporary.write_bytes((source / "MARKET_REPORT.html").read_bytes())
    html_temporary.replace(html_path)
    image_path = target_dir / f"{bundle['displayDate']}.png"
    image_temporary = image_path.with_name(f".{image_path.name}.tmp")
    image_temporary.write_bytes((source / "market_dashboard.png").read_bytes())
    image_temporary.replace(image_path)
    index = update_index(target_dir, bundle)
    return report_path, target_dir / "index.json", index


def _r2_client() -> Any:
    import boto3

    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Missing R2 environment variables: {', '.join(missing)}")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def hydrate_index_from_r2(project_root: Path, bucket: str) -> bool:
    """Restore the durable report index before an ephemeral Actions run updates it."""

    from botocore.exceptions import ClientError

    try:
        response = _r2_client().get_object(Bucket=bucket, Key="market-reports/index.json")
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise
    value = json.loads(response["Body"].read().decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("reports"), list):
        raise ValueError("R2 market report index has an invalid shape")
    target = project_root / "public" / "data" / "market-reports" / "index.json"
    _write_json_atomic(target, value)
    return True


def upload_r2(report_path: Path, index_path: Path, bucket: str) -> None:
    client = _r2_client()
    objects = [
        (report_path, f"market-reports/{report_path.name}", "application/json; charset=utf-8", "public, max-age=31536000, immutable"),
    ]
    html_path = report_path.with_suffix(".html")
    if html_path.exists():
        objects.append(
            (html_path, f"market-reports/{html_path.name}", "text/html; charset=utf-8", "public, max-age=31536000, immutable")
        )
    image_path = report_path.with_suffix(".png")
    if image_path.exists():
        objects.append((image_path, f"market-reports/{image_path.name}", "image/png", "public, max-age=31536000, immutable"))
    # Publish the index last so readers never see an entry before its assets exist.
    objects.append((index_path, "market-reports/index.json", "application/json; charset=utf-8", "public, max-age=60"))
    for local_path, object_key, content_type, cache_control in objects:
        body = local_path.read_bytes()
        client.put_object(
            Bucket=bucket,
            Key=object_key,
            Body=body,
            ContentType=content_type,
            CacheControl=cache_control,
        )
        metadata = client.head_object(Bucket=bucket, Key=object_key)
        if int(metadata.get("ContentLength", -1)) != len(body):
            raise RuntimeError(f"R2 upload verification failed: {object_key}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--r2-bucket", default=os.environ.get("R2_BUCKET_NAME", "closeprice"))
    parser.add_argument("--upload-r2", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    project_root = args.project_root.resolve()
    r2_index_loaded = False
    if args.upload_r2:
        r2_index_loaded = hydrate_index_from_r2(project_root, args.r2_bucket)
    report_path, index_path, index = publish_local(source, project_root)
    if args.upload_r2:
        upload_r2(report_path, index_path, args.r2_bucket)
    print(
        json.dumps(
            {
                "display_date": index["latestDisplayDate"],
                "report_path": str(report_path),
                "html_path": str(report_path.with_suffix('.html')),
                "image_path": str(report_path.with_suffix('.png')),
                "index_path": str(index_path),
                "r2_index_loaded": r2_index_loaded,
                "r2_uploaded": args.upload_r2,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
