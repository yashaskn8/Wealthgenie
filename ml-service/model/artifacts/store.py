"""Immutable local and Mongo GridFS model-bundle storage."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import zipfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from model.artifacts.bundle import (
    ArtifactBundleError,
    materialize_verified_bundle,
    verify_bundle,
)


_SAFE_BUNDLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MAX_BUNDLE_BYTES = 512 * 1024 * 1024
_GRIDFS_INDEX_NAME = "uniq_immutable_model_bundle_id"


class ArtifactStoreError(RuntimeError):
    """Artifact storage was unavailable or violated immutable bundle identity."""


class ArtifactStore(ABC):
    @abstractmethod
    def put_bundle(self, bundle_dir: Path, expected_manifest_sha256: str) -> dict[str, str]:
        raise NotImplementedError

    @abstractmethod
    def get_bundle(self, bundle_id: str, expected_manifest_sha256: str) -> Path:
        raise NotImplementedError

    @abstractmethod
    def exists(self, bundle_id: str, expected_manifest_sha256: str) -> bool:
        raise NotImplementedError

    def verify_bundle(self, bundle_dir: Path, expected_manifest_sha256: str) -> dict[str, Any]:
        return verify_bundle(bundle_dir, expected_manifest_sha256)

    def _verify_stored_bundle(self, bundle_dir: Path, expected_manifest_sha256: str) -> dict[str, Any]:
        """Verify stored bytes without treating storage as serving authorization.

        Candidate bundles may be integrity-verified and registered before they
        qualify for serving. Deserialization and promotion still call the
        public ``verify_bundle`` method, which requires serving qualification.
        """
        return verify_bundle(
            bundle_dir,
            expected_manifest_sha256,
            require_serving_qualified=False,
        )


class LocalArtifactStore(ArtifactStore):
    """Filesystem store for local development and tests; writes are immutable."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put_bundle(self, bundle_dir: Path, expected_manifest_sha256: str) -> dict[str, str]:
        from pymongo.errors import DuplicateKeyError

        verified = self._verify_stored_bundle(bundle_dir, expected_manifest_sha256)
        bundle_id = _validate_bundle_id(verified["manifest"]["bundle_id"])
        destination = self.root / bundle_id
        if destination.exists():
            existing = self._verify_stored_bundle(destination, expected_manifest_sha256)
            if existing["manifest"]["bundle_id"] != bundle_id:
                raise ArtifactStoreError("existing local bundle identity mismatch")
            return {"bundle_id": bundle_id, "bundle_manifest_sha256": expected_manifest_sha256}

        isolated = materialize_verified_bundle(verified)
        staging = self.root / f".{bundle_id}.{os.urandom(8).hex()}.pending"
        try:
            shutil.copytree(isolated, staging, copy_function=shutil.copyfile)
            try:
                os.rename(staging, destination)
            except FileExistsError:
                existing = self._verify_stored_bundle(destination, expected_manifest_sha256)
                if existing["manifest"]["bundle_id"] != bundle_id:
                    raise ArtifactStoreError("concurrent local bundle registration conflict")
            self._verify_stored_bundle(destination, expected_manifest_sha256)
        finally:
            shutil.rmtree(isolated, ignore_errors=True)
            shutil.rmtree(staging, ignore_errors=True)
        return {"bundle_id": bundle_id, "bundle_manifest_sha256": expected_manifest_sha256}

    def get_bundle(self, bundle_id: str, expected_manifest_sha256: str) -> Path:
        bundle_id = _validate_bundle_id(bundle_id)
        path = (self.root / bundle_id).resolve(strict=True)
        if path.parent != self.root:
            raise ArtifactStoreError("bundle path escapes local artifact store")
        self._verify_stored_bundle(path, expected_manifest_sha256)
        return path

    def exists(self, bundle_id: str, expected_manifest_sha256: str) -> bool:
        try:
            self.get_bundle(bundle_id, expected_manifest_sha256)
            return True
        except (FileNotFoundError, ArtifactBundleError, ArtifactStoreError):
            return False


class MongoGridFSArtifactStore(ArtifactStore):
    """Cross-replica immutable GridFS bundle store; indexes are migration-owned."""

    def __init__(self, database: Any, bucket_name: str = "model_artifacts"):
        from gridfs import GridFSBucket

        self.database = database
        self.bucket_name = bucket_name
        self._bucket = GridFSBucket(database, bucket_name=bucket_name)
        files_collection = database[f"{bucket_name}.files"]
        indexes = files_collection.index_information()
        required = indexes.get(_GRIDFS_INDEX_NAME)
        if not required or not required.get("unique") or required.get("key") != [("metadata.bundle_id", 1)]:
            raise ArtifactStoreError("required immutable GridFS bundle index is missing; run Phase-3 migration")

    def put_bundle(self, bundle_dir: Path, expected_manifest_sha256: str) -> dict[str, str]:
        verified = self._verify_stored_bundle(bundle_dir, expected_manifest_sha256)
        bundle_id = _validate_bundle_id(verified["manifest"]["bundle_id"])
        existing = self.database[f"{self.bucket_name}.files"].find_one(
            {"metadata.bundle_id": bundle_id}, {"_id": 1, "metadata": 1}
        )
        if existing:
            if existing.get("metadata", {}).get("bundle_manifest_sha256") != expected_manifest_sha256:
                raise ArtifactStoreError("immutable bundle ID already exists with a different manifest hash")
            materialized = self.get_bundle(bundle_id, expected_manifest_sha256)
            shutil.rmtree(materialized.parent, ignore_errors=True)
            return {"bundle_id": bundle_id, "bundle_manifest_sha256": expected_manifest_sha256}

        isolated = materialize_verified_bundle(verified)
        archive = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
        try:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as package:
                for path in sorted(isolated.iterdir(), key=lambda item: item.name):
                    package.write(path, arcname=path.name)
            size = archive.tell()
            if size <= 0 or size > _MAX_BUNDLE_BYTES:
                raise ArtifactStoreError("model bundle archive exceeds storage size limits")
            archive.seek(0)
            try:
                self._bucket.upload_from_stream(
                    f"{bundle_id}.zip",
                    archive,
                    metadata={
                        "bundle_id": bundle_id,
                        "bundle_manifest_sha256": expected_manifest_sha256,
                        "immutable": True,
                    },
                )
            except DuplicateKeyError as exc:
                existing = self.database[f"{self.bucket_name}.files"].find_one(
                    {"metadata.bundle_id": bundle_id}, {"metadata": 1}
                )
                if not existing or existing.get("metadata", {}).get("bundle_manifest_sha256") != expected_manifest_sha256:
                    raise ArtifactStoreError("concurrent immutable bundle registration conflict") from exc
                materialized = self.get_bundle(bundle_id, expected_manifest_sha256)
                shutil.rmtree(materialized.parent, ignore_errors=True)
        finally:
            archive.close()
            shutil.rmtree(isolated, ignore_errors=True)
        return {"bundle_id": bundle_id, "bundle_manifest_sha256": expected_manifest_sha256}

    def get_bundle(self, bundle_id: str, expected_manifest_sha256: str) -> Path:
        bundle_id = _validate_bundle_id(bundle_id)
        records = list(self.database[f"{self.bucket_name}.files"].find(
            {"metadata.bundle_id": bundle_id}, {"_id": 1, "length": 1, "metadata": 1}
        ).limit(2))
        if len(records) != 1:
            raise ArtifactStoreError("immutable bundle is missing or duplicated in GridFS")
        record = records[0]
        metadata = record.get("metadata", {})
        if metadata.get("bundle_manifest_sha256") != expected_manifest_sha256:
            raise ArtifactStoreError("GridFS bundle hash does not match the registry trust anchor")
        if not isinstance(record.get("length"), int) or record["length"] <= 0 or record["length"] > _MAX_BUNDLE_BYTES:
            raise ArtifactStoreError("GridFS bundle size is invalid")

        root = Path(tempfile.mkdtemp(prefix="wealthgenie-gridfs-bundle-")).resolve(strict=True)
        archive_path = root / "bundle.zip"
        output = root / "content"
        output.mkdir()
        try:
            with archive_path.open("xb") as stream:
                self._bucket.download_to_stream(record["_id"], stream)
            with zipfile.ZipFile(archive_path, "r") as package:
                infos = package.infolist()
                names = [info.filename for info in infos]
                if len(names) != len(set(names)) or any(
                    Path(name).name != name or name in {".", ".."} or info.is_dir()
                    for name, info in ((info.filename, info) for info in infos)
                ):
                    raise ArtifactStoreError("GridFS bundle archive contains unsafe members")
                if sum(info.file_size for info in infos) > _MAX_BUNDLE_BYTES:
                    raise ArtifactStoreError("GridFS bundle expands beyond the configured size limit")
                for info in infos:
                    target = output / info.filename
                    with package.open(info, "r") as source, target.open("xb") as destination:
                        shutil.copyfileobj(source, destination, length=1024 * 1024)
            verified = self._verify_stored_bundle(output, expected_manifest_sha256)
            if verified["manifest"]["bundle_id"] != bundle_id:
                raise ArtifactStoreError("GridFS archive bundle ID does not match its immutable record")
            return output
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise
        finally:
            archive_path.unlink(missing_ok=True)

    def exists(self, bundle_id: str, expected_manifest_sha256: str) -> bool:
        try:
            path = self.get_bundle(bundle_id, expected_manifest_sha256)
            shutil.rmtree(path.parent, ignore_errors=True)
            return True
        except (ArtifactBundleError, ArtifactStoreError, FileNotFoundError):
            return False


def get_artifact_store(
    environment: str,
    database: Any = None,
    local_root: Path | None = None,
    *,
    state_backend: str | None = None,
) -> ArtifactStore:
    """Select a store without allowing production to silently use pod-local files."""
    normalized = str(environment).strip().lower()
    backend = str(state_backend or os.environ.get("ML_STATE_BACKEND", "auto")).strip().lower()
    if normalized in {"production", "prod"} or backend == "mongodb":
        if database is None:
            raise ArtifactStoreError("Mongo-backed model state requires shared Mongo/GridFS artifact storage")
        return MongoGridFSArtifactStore(database)
    if normalized not in {"local", "development", "test", "testing"}:
        raise ArtifactStoreError(f"unsupported artifact storage environment: {environment}")
    configured_root = os.environ.get("ML_ARTIFACT_STORE_PATH", "").strip()
    root = local_root or (
        Path(configured_root)
        if configured_root
        else Path(__file__).resolve().parents[2] / "reports" / "model_artifacts"
    )
    return LocalArtifactStore(root)


def _validate_bundle_id(value: Any) -> str:
    if not isinstance(value, str) or not _SAFE_BUNDLE_ID.fullmatch(value) or ".." in value:
        raise ArtifactStoreError("bundle_id is not a safe immutable storage key")
    return value
