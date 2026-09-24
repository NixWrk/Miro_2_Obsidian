"""Load and apply this project's board / miroSource / miroCanvas JSON Schemas.

The schemas live under ``miro2obsidian/schemas/v<version>/``, shipped with the
package. They are the contract shared with the miro-canvas plugin
(https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas), which keeps a pinned
copy of them and runs their example boards through its own metadata reader:
this module never redefines what a valid board or a valid `miroCanvas` looks
like, it only reads the same schema files.

No network access is used to resolve `$ref`.  Every schema a board might
reference is registered up front in a local `referencing.Registry`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

SCHEMAS_ROOT = Path(__file__).resolve().parent / "schemas"

#: The schema version this codebase writes and expects to read back.
CURRENT_SCHEMA_VERSION = 1

#: Schema file names, keyed by what each one describes.
_BOARD_SCHEMA = "board.schema.json"
_SOURCE_SCHEMA = "miro-source.schema.json"
_CANVAS_SCHEMA = "miro-canvas.schema.json"
_ALL_SCHEMAS = (_BOARD_SCHEMA, _SOURCE_SCHEMA, _CANVAS_SCHEMA)


@dataclass(frozen=True)
class SchemaIssue:
    """One thing wrong with a document, at a JSON-pointer path.

    `path` is empty for an issue about the document as a whole (for example,
    the root not being an object at all).
    """

    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.path}: {self.message}" if self.path else self.message


def _schema_dir(version: int) -> Path:
    directory = SCHEMAS_ROOT / f"v{version}"
    if not directory.is_dir():
        raise FileNotFoundError(f"No schema directory published for version {version}: {directory}")
    return directory


def _load_schema(version: int, name: str) -> dict[str, Any]:
    path = _schema_dir(version) / name
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _registry(version: int) -> Registry:
    """A local, offline registry: every schema this version publishes, keyed by its own `$id`."""
    resources = [
        (schema["$id"], Resource.from_contents(schema, default_specification=DRAFT202012))
        for schema in (_load_schema(version, name) for name in _ALL_SCHEMAS)
    ]
    return Registry().with_resources(resources)


def _pointer(path: Iterable[Any]) -> str:
    parts = list(path)
    if not parts:
        return ""
    return "/" + "/".join(str(part) for part in parts)


def _issues_from_errors(errors: Iterable[Any]) -> list[SchemaIssue]:
    ordered = sorted(errors, key=lambda error: list(map(str, error.absolute_path)))
    return [SchemaIssue(path=_pointer(error.absolute_path), message=error.message) for error in ordered]


def _validate(document: Any, version: int, schema_name: str) -> list[SchemaIssue]:
    schema = _load_schema(version, schema_name)
    validator = Draft202012Validator(schema, registry=_registry(version))
    return _issues_from_errors(validator.iter_errors(document))


def validate_board(document: Any, version: int = CURRENT_SCHEMA_VERSION) -> list[SchemaIssue]:
    """Issues against `board.schema.json`: a whole `.canvas` document."""
    return _validate(document, version, _BOARD_SCHEMA)


def validate_source(document: Any, version: int = CURRENT_SCHEMA_VERSION) -> list[SchemaIssue]:
    """Issues against `miro-source.schema.json`: a bare `miroSource` value."""
    return _validate(document, version, _SOURCE_SCHEMA)


def validate_canvas_metadata(document: Any, version: int = CURRENT_SCHEMA_VERSION) -> list[SchemaIssue]:
    """Issues against `miro-canvas.schema.json`: a bare `miroCanvas` value."""
    return _validate(document, version, _CANVAS_SCHEMA)
