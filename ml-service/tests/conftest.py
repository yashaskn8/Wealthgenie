"""Pytest-wide isolation for local ML state and retraining artifacts."""

import os
import shutil
import tempfile
import hashlib
import json
from pathlib import Path

import pytest


_TEST_STATE_DIR = tempfile.mkdtemp(prefix="wealthgenie_ml_tests_")
os.environ.setdefault("ML_REGISTRY_DB_PATH", os.path.join(_TEST_STATE_DIR, "model_registry.db"))
os.environ.setdefault("ML_CANDIDATE_MODEL_DIR", os.path.join(_TEST_STATE_DIR, "candidates"))
# Tests must opt into a named non-production mode instead of inheriting the
# service's old implicit-development default.
os.environ.setdefault("ENVIRONMENT", "test")


def pytest_sessionfinish(session, exitstatus):
    del session, exitstatus
    shutil.rmtree(_TEST_STATE_DIR, ignore_errors=True)


@pytest.fixture
def unqualified_bundle_factory(tmp_path):
    """Build integrity-pinned, explicitly non-serving test bundles from real test artifacts."""
    def build(architecture, source_files, bundle_id="test-bundle"):
        from model.artifacts.bundle import ARCHITECTURE_FILES, MANIFEST_FILENAME, build_bundle_manifest
        from model.architecture.base import BasePredictor
        from model.data.feature_engineering import FEATURE_NAMES, FEATURE_SCHEMA_VERSION

        filenames = ARCHITECTURE_FILES[architecture]
        root = tmp_path / bundle_id
        root.mkdir()
        for role, filename in filenames.items():
            if role == "evaluation_report":
                continue
            source = Path(source_files[role])
            shutil.copyfile(source, root / filename)

        metadata_path = root / filenames["metadata"]
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        dataset_lineage = {
            "generator": "test-only-fixture",
            "generation_parameters": {"fixture": bundle_id},
            "split_identity": {
                "train_indices_sha256": hashlib.sha256(b"train").hexdigest(),
                "validation_indices_sha256": hashlib.sha256(b"validation").hexdigest(),
                "test_indices_sha256": hashlib.sha256(b"test").hexdigest(),
            },
        }
        training_data_hash = hashlib.sha256(f"test-only:{bundle_id}".encode()).hexdigest()
        training_timestamp = "2026-09-24T12:00:00+00:00"
        model_version = f"{architecture}-test-v1"
        metadata.update({
            "model_version": model_version,
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "feature_names": FEATURE_NAMES,
            "target_classes": BasePredictor.TARGET_CLASSES,
            "training_data_hash": training_data_hash,
            "training_code_git_sha": None,
            "training_timestamp": training_timestamp,
            "dataset_lineage": dataset_lineage,
        })
        metadata_path.write_text(json.dumps(metadata, sort_keys=True), encoding="utf-8")
        report_bytes = json.dumps({"evaluation_run_id": f"{bundle_id}-eval", "metrics": {}}, sort_keys=True).encode()
        (root / filenames["evaluation_report"]).write_bytes(report_bytes)
        manifest = build_bundle_manifest(
            root,
            bundle_id=bundle_id,
            architecture=architecture,
            model_version=model_version,
            feature_schema_version=FEATURE_SCHEMA_VERSION,
            feature_names=FEATURE_NAMES,
            target_classes=BasePredictor.TARGET_CLASSES,
            training_data_hash=training_data_hash,
            training_code_git_sha=None,
            training_timestamp=training_timestamp,
            dataset_lineage=dataset_lineage,
            python_version="3.12-test",
            framework_versions={"test-fixture": "1"},
            evaluation_report_id=f"{bundle_id}-eval",
            evaluation_report_sha256=hashlib.sha256(report_bytes).hexdigest(),
            serving_qualified=False,
        )
        (root / MANIFEST_FILENAME).write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        return root, manifest["bundle_manifest_sha256"]

    return build
