"""Immutable report objects with one conditional publication commit per product."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from .report_time import utc_now


def encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode()


class ReleaseConflict(RuntimeError):
    pass


class ReportStore:
    def __init__(self, client: Any, bucket: str, product: str):
        if product not in {"morning", "trading"}:
            raise ValueError("Unknown report product")
        self.client, self.bucket, self.product = client, bucket, product
        self.pointer = f"report-publications/{product}/current.json"
        current = self._get(self.pointer)
        self.etag = current[1] if current else None
        self.manifest = json.loads(current[0]) if current else {"schemaVersion": 1, "objects": {}, "jobs": {}}
        self.staged: dict[str, tuple[bytes, str]] = {}

    @classmethod
    def from_environment(cls, product: str):
        from .publish_market_report_web import _r2_client

        return cls(_r2_client(), os.environ["R2_BUCKET_NAME"], product)

    def _get(self, key: str) -> tuple[bytes, str] | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        stream = response["Body"]
        try:
            return stream.read(), response["ETag"]
        finally:
            stream.close()

    def read(self, logical: str) -> bytes | None:
        if logical in self.staged:
            return self.staged[logical][0]
        entry = self.manifest["objects"].get(logical)
        value = self._get(entry["key"] if entry else logical)
        if entry and value is None:
            raise RuntimeError(f"Committed report object is missing: {logical}")
        return value[0] if value else None

    def load(self, logical: str) -> dict | None:
        raw = self.read(logical)
        return json.loads(raw) if raw is not None else None

    def stage(self, logical: str, value: Any, content_type: str = "application/json; charset=utf-8"):
        self.staged[logical] = (value if isinstance(value, bytes) else encode(value), content_type)

    def keys(self, prefix: str) -> list[str]:
        result = {key for key in self.manifest["objects"] if key.startswith(prefix)}
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            result.update(item["Key"] for item in page.get("Contents", []))
        return sorted(result)

    def commit(self, *, job_date: str | None = None, status: str = "published", details: dict | None = None) -> dict:
        objects = dict(self.manifest["objects"])
        for logical, (body, content_type) in self.staged.items():
            digest = hashlib.sha256(body).hexdigest()
            key = f"report-publications/{self.product}/objects/{digest}"
            self.client.put_object(Bucket=self.bucket, Key=key, Body=body,
                                   ContentType=content_type, CacheControl="public, max-age=31536000, immutable")
            saved = self._get(key)
            if saved is None or hashlib.sha256(saved[0]).hexdigest() != digest:
                raise RuntimeError(f"Report upload verification failed: {logical}")
            objects[logical] = {"key": key, "sha256": digest, "contentType": content_type}
        jobs = dict(self.manifest.get("jobs", {}))
        if job_date:
            jobs[job_date] = {"status": status, "checkedAt": utc_now().isoformat(), **(details or {})}
        manifest = {"schemaVersion": 1, "objects": objects, "jobs": jobs,
                    "publishedAt": utc_now().isoformat(), "codeSha": os.environ.get("GITHUB_SHA", "local"),
                    "previousReleaseId": self.manifest.get("releaseId")}
        release_id = hashlib.sha256(encode(manifest)).hexdigest()
        manifest["releaseId"] = release_id
        body = encode(manifest)
        # A release file is auditable even if its later pointer commit loses a race.
        self.client.put_object(Bucket=self.bucket, Key=f"report-publications/{self.product}/releases/{release_id}.json",
                               Body=body, ContentType="application/json", CacheControl="private, no-store")
        condition = {"IfMatch": self.etag} if self.etag else {"IfNoneMatch": "*"}
        try:
            response = self.client.put_object(Bucket=self.bucket, Key=self.pointer, Body=body,
                                             ContentType="application/json", CacheControl="no-store", **condition)
        except Exception as error:
            code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
            if code in {"412", "PreconditionFailed", "ConditionalRequestConflict", "409"}:
                raise ReleaseConflict("Publication changed; reload state before retrying") from error
            raise
        self.manifest, self.etag = manifest, response["ETag"]
        self.staged.clear()
        return manifest
