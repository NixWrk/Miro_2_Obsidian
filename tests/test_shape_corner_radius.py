"""Rectangular shape radius uses board units and preserves unknown fields."""
from copy import deepcopy

import pytest

from miro2obsidian.schema import validate_canvas_metadata


@pytest.mark.parametrize("radius", [0, 16, 1000])
def test_shape_radius_valid_and_readonly(radius):
    data = {"schemaVersion": 1, "localOverrides": {"shape": {"shape": {"kind": "round_rectangle", "fallback": "text", "future": 1}, "cornerRadius": radius, "future": {"keep": True}}}}
    original = deepcopy(data)
    assert validate_canvas_metadata(data) == []
    assert data == original


@pytest.mark.parametrize("radius", [-1, 1001, "16", True, None])
def test_shape_radius_refuses_invalid_values(radius):
    data = {"schemaVersion": 1, "localOverrides": {"shape": {"cornerRadius": radius}}}
    assert validate_canvas_metadata(data)
