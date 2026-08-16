from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "Json_2_Canvas"))

from Converter import (  # noqa: E402
    _source_canvas_metadata,
    convert_item_to_canvas_node,
    convert_item_to_edge,
    get_miro_subtype,
)


def test_malformed_mapping_fields_do_not_abort_known_item_conversion() -> None:
    card = {
        "id": "card-1",
        "type": "card",
        "data": "raw-data",
        "style": ["raw-style"],
        "position": {"x": 0, "y": 0},
        "geometry": {"width": 200, "height": 100},
    }

    node = convert_item_to_canvas_node(card, str(REPO_ROOT), str(REPO_ROOT))

    assert node is not None
    assert node["id"] == "card-1"
    assert (
        convert_item_to_edge(
            {
                "id": "connector-1",
                "type": "connector",
                "startItem": "invalid",
                "endItem": ["invalid"],
                "style": "invalid",
            }
        )
        is None
    )


def test_shape_subtype_accepts_string_object_and_malformed_data() -> None:
    assert get_miro_subtype({"shape": "round_rectangle"}) == "round_rectangle"
    assert get_miro_subtype({"shape": {"shape": "Circle"}}) == "circle"
    assert get_miro_subtype({"data": {"shape": "Rectangle"}}) == "rectangle"
    assert get_miro_subtype({"data": "raw-data"}) == ""


def test_doc_format_image_slot_is_not_reintroduced_as_placeholder() -> None:
    node = convert_item_to_canvas_node(
        {
            "id": "slot-image",
            "type": "image",
            "data": {"imageUrl": "https://example.test/image.png"},
            "position": {"x": 10, "y": 20, "slotId": "slot-1"},
            "geometry": {"width": 50, "height": 30},
            "local_name": "image.png",
        },
        str(REPO_ROOT),
        str(REPO_ROOT),
    )

    assert node is None


def test_canvas_source_metadata_keeps_original_malformed_values() -> None:
    source = {"items": [{"id": "item-1", "type": "card", "data": "raw-data"}]}

    metadata = _source_canvas_metadata(source)

    assert metadata == source
    assert metadata is not source
