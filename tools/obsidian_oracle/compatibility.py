"""Offline compatibility profiles for the project-local Obsidian oracle.

The matrix is intentionally data-driven and does not import Obsidian or make
network calls.  It gives the real-vault harness deterministic documents to
stage while the TypeScript adapters exercise the actual runtime shape when a
desktop session is available.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import REPO_ROOT, load_json
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import REPO_ROOT, load_json


FIXTURE_ROOT = REPO_ROOT / "tools" / "obsidian_oracle" / "fixtures" / "m0"
MATRIX_PATH = FIXTURE_ROOT / "compatibility_matrix.json"
MATRIX_SCHEMA_VERSION = 1
CANVAS_FILES = {"native.canvas", "miro-metadata.canvas"}


@dataclass(frozen=True)
class CompatibilityProfile:
    """One matrix row describing a controlled oracle configuration."""

    id: str
    description: str
    canvas: str
    native_canvas: bool
    advanced_canvas: bool
    miro_canvas: bool
    expected_native_adapter: str
    expected_advanced_adapter: str
    expected_metadata: str

    @property
    def canvas_path(self) -> Path:
        candidate = (FIXTURE_ROOT / self.canvas).resolve(strict=False)
        try:
            candidate.relative_to(FIXTURE_ROOT.resolve())
        except ValueError as exc:
            raise ValueError(f"Compatibility fixture escapes fixture root: {self.canvas}") from exc
        if candidate.name not in CANVAS_FILES or not candidate.is_file():
            raise ValueError(f"Compatibility fixture is missing: {candidate}")
        return candidate


def _required_string(payload: Mapping[str, Any], key: str, path: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path}.{key} must be a non-empty string")
    return value


def _required_bool(payload: Mapping[str, Any], key: str, path: str) -> bool:
    value = payload.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"{path}.{key} must be a boolean")
    return value


def _parse_profile(raw: Any, index: int) -> CompatibilityProfile:
    path = f"profiles[{index}]"
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must be an object")
    expected = raw.get("expected")
    if not isinstance(expected, dict):
        raise ValueError(f"{path}.expected must be an object")
    canvas = _required_string(raw, "canvas", path)
    if Path(canvas).name != canvas or canvas not in CANVAS_FILES:
        raise ValueError(f"{path}.canvas must name a committed M0 canvas fixture")
    return CompatibilityProfile(
        id=_required_string(raw, "id", path),
        description=_required_string(raw, "description", path),
        canvas=canvas,
        native_canvas=_required_bool(raw, "nativeCanvas", path),
        advanced_canvas=_required_bool(raw, "advancedCanvas", path),
        miro_canvas=_required_bool(raw, "miroCanvas", path),
        expected_native_adapter=_required_string(expected, "nativeAdapter", f"{path}.expected"),
        expected_advanced_adapter=_required_string(expected, "advancedAdapter", f"{path}.expected"),
        expected_metadata=_required_string(expected, "metadata", f"{path}.expected"),
    )


def load_compatibility_matrix(path: Path | None = None) -> tuple[CompatibilityProfile, ...]:
    """Load and validate the committed four-profile compatibility matrix."""

    matrix_path = Path(path or MATRIX_PATH).resolve(strict=False)
    fixture_root = FIXTURE_ROOT.resolve()
    try:
        matrix_path.relative_to(fixture_root)
    except ValueError as exc:
        raise ValueError("Compatibility matrix must live below the committed M0 fixture root") from exc
    payload = load_json(matrix_path)
    if not isinstance(payload, dict):
        raise ValueError("Compatibility matrix must be a JSON object")
    if payload.get("schemaVersion") != MATRIX_SCHEMA_VERSION:
        raise ValueError(f"Compatibility matrix schemaVersion must be {MATRIX_SCHEMA_VERSION}")
    raw_profiles = payload.get("profiles")
    if not isinstance(raw_profiles, list) or not raw_profiles:
        raise ValueError("Compatibility matrix profiles must be a non-empty array")

    profiles = tuple(_parse_profile(raw, index) for index, raw in enumerate(raw_profiles))
    ids = [profile.id for profile in profiles]
    if len(set(ids)) != len(ids):
        raise ValueError("Compatibility matrix profile IDs must be unique")
    return profiles


def get_profile(profile_id: str) -> CompatibilityProfile:
    """Return one named profile or raise a user-facing validation error."""

    for profile in load_compatibility_matrix():
        if profile.id == profile_id:
            return profile
    available = ", ".join(profile.id for profile in load_compatibility_matrix())
    raise ValueError(f"Unknown compatibility profile {profile_id!r}; choose one of: {available}")


def load_profile_document(profile: CompatibilityProfile | str) -> dict[str, Any]:
    """Read a detached Canvas fixture and verify its metadata expectation."""

    selected = get_profile(profile) if isinstance(profile, str) else profile
    document = load_json(selected.canvas_path)
    if not isinstance(document, dict):
        raise ValueError(f"Canvas fixture must be a JSON object: {selected.canvas_path}")
    if not isinstance(document.get("nodes"), list) or not isinstance(document.get("edges"), list):
        raise ValueError(f"Canvas fixture must contain nodes and edges arrays: {selected.canvas_path}")
    has_metadata = "miroCanvas" in document
    if has_metadata != selected.miro_canvas:
        raise ValueError(
            f"Profile {selected.id} metadata expectation does not match {selected.canvas_path.name}"
        )
    if selected.miro_canvas:
        metadata = document.get("miroCanvas")
        if not isinstance(metadata, dict) or metadata.get("schemaVersion") != 1:
            raise ValueError(f"Miro Canvas fixture metadata is not schema v1: {selected.canvas_path}")
    return document


def profile_ids() -> tuple[str, ...]:
    """Return profile IDs in committed display/order sequence."""

    return tuple(profile.id for profile in load_compatibility_matrix())
