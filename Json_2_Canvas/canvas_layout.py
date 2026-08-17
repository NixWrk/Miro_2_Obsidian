"""Small target-side layout operations shared by the Canvas converter."""

from __future__ import annotations

from typing import Any


def center_nodes(nodes: list[dict[str, Any]], bounds: dict[str, float] | None) -> None:
    """Center nodes around the Canvas origin using precomputed real-node bounds."""
    if not bounds:
        return
    dx = -(bounds["x"] + bounds["width"] / 2.0)
    dy = -(bounds["y"] + bounds["height"] / 2.0)
    if abs(dx) <= 1e-9 and abs(dy) <= 1e-9:
        return
    for node in nodes:
        try:
            node["x"] = float(node["x"]) + dx
            node["y"] = float(node["y"]) + dy
        except (KeyError, TypeError, ValueError):
            continue
