"""Small, non-owning views over canonical Miro items.

The converter receives dictionaries assembled by the export/merge pipeline.  This
module deliberately does not introduce a second representation: :class:`MiroItem`
keeps a reference to the original mapping and only centralises the defensive
lookups that are repeated throughout the converter.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


_EMPTY: Mapping[str, Any] = {}


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else _EMPTY


@dataclass(frozen=True, slots=True)
class MiroBounds:
    """A Miro item's centre and size, with convenient top-left coordinates."""

    center_x: float
    center_y: float
    width: float
    height: float

    @property
    def x(self) -> float:
        return self.center_x - self.width / 2.0

    @property
    def y(self) -> float:
        return self.center_y - self.height / 2.0


@dataclass(frozen=True, slots=True)
class MiroItem:
    """Typed accessors for one raw canonical item; ``raw`` is never copied."""

    raw: Mapping[str, Any]

    def __post_init__(self) -> None:
        if not isinstance(self.raw, Mapping):
            raise TypeError("MiroItem.raw must be a mapping")

    @property
    def id(self) -> str:
        return str(self.raw.get("id") or "")

    @property
    def type(self) -> str:
        return str(self.raw.get("type") or "")

    @property
    def kind(self) -> str:
        return self.type.lower()

    @property
    def data(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("data"))

    @property
    def style(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("style"))

    @property
    def parent(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("parent"))

    @property
    def group(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("group"))

    @property
    def links(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("links"))

    @property
    def position(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("position"))

    @property
    def geometry(self) -> Mapping[str, Any]:
        return _mapping(self.raw.get("geometry"))

    @property
    def parent_id(self) -> str | None:
        """Return group id first, matching Miro's usual item shape."""
        for source in (self.group, self.parent):
            value = source.get("id")
            if isinstance(value, (str, int)):
                return str(value)
        return None

    @property
    def title(self) -> str:
        value = self.raw.get("title") or self.data.get("title") or self.raw.get("name")
        return str(value or "")

    @property
    def text(self) -> str:
        """Best-effort common text field, without imposing item-specific policy."""
        for value in (
            self.raw.get("text"),
            self.raw.get("plain_text"),
            self.data.get("content"),
            self.data.get("text"),
            self.data.get("title"),
            self.raw.get("title"),
        ):
            if value:
                return str(value)
        return ""

    @property
    def bounds(self) -> MiroBounds | None:
        """Return centre/size geometry, or ``None`` when it cannot be read."""
        position = self.position
        geometry = self.geometry
        try:
            width = float(geometry.get("width") or 0.0)
            height = float(geometry.get("height") or 0.0)
            center_x = float(position.get("x") or 0.0)
            center_y = float(position.get("y") or 0.0)
        except (TypeError, ValueError):
            return None
        if width <= 0 or height <= 0:
            return None
        return MiroBounds(center_x, center_y, width, height)


def view(item: Mapping[str, Any] | MiroItem) -> MiroItem:
    """Wrap an item once while allowing callers to pass an existing view."""
    return item if isinstance(item, MiroItem) else MiroItem(item)

