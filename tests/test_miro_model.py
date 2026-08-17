from __future__ import annotations

from Json_2_Canvas.miro_model import MiroBounds, MiroItem, view


def test_view_keeps_raw_item_without_copying() -> None:
    raw = {
        "id": 7,
        "type": "Card",
        "data": {"content": "Hello"},
        "style": {"fillColor": "#fff"},
        "parent": {"id": "frame-1"},
        "position": {"x": 20, "y": 30},
        "geometry": {"width": 100, "height": 40},
    }

    item = view(raw)

    assert isinstance(item, MiroItem)
    assert item.raw is raw
    assert item.id == "7"
    assert item.type == "Card"
    assert item.kind == "card"
    assert item.data is raw["data"]
    assert item.style is raw["style"]
    assert item.parent is raw["parent"]
    assert item.position is raw["position"]
    assert item.geometry is raw["geometry"]
    assert item.parent_id == "frame-1"
    assert item.text == "Hello"

    raw["data"]["content"] = "Updated"
    assert item.text == "Updated"


def test_bounds_are_center_based_and_expose_top_left() -> None:
    item = MiroItem(
        {
            "position": {"x": 40, "y": 50},
            "geometry": {"width": 20, "height": 10},
        }
    )

    assert item.bounds == MiroBounds(40.0, 50.0, 20.0, 10.0)
    assert item.bounds.x == 30.0
    assert item.bounds.y == 45.0


def test_malformed_nested_values_use_empty_views() -> None:
    item = MiroItem({"data": "raw", "style": [], "position": None})

    assert item.data == {}
    assert item.style == {}
    assert item.position == {}
    assert item.bounds is None
