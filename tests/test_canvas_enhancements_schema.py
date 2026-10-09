"""Canvas feature fields remain typed and forward compatible."""
from copy import deepcopy

from miro2obsidian.schema import validate_canvas_metadata


def metadata():
    return {
        "schemaVersion": 1,
        "properties": {"tags": ["planning"], "aliases": ["Plan"], "owner": "[[Team]]"},
        "nodeRedirects": {"old": {"file": "boards/New.canvas", "nodeId": "old", "future": 1}},
        "localOverrides": {
            "group": {
                "customStyles": ["quiet-card"],
                "groupCollapse": {"width": 800, "height": 600, "children": ["note"], "future": True},
            }
        },
    }


def test_feature_fields_and_unknown_extensions_are_valid():
    value = metadata()
    original = deepcopy(value)
    assert validate_canvas_metadata(value) == []
    assert value == original


def test_properties_require_an_object():
    value = metadata()
    value["properties"] = "not an object"
    assert validate_canvas_metadata(value)


def test_card_redirects_require_a_destination():
    value = metadata()
    value["nodeRedirects"]["old"]["file"] = ""
    assert validate_canvas_metadata(value)


def test_collapsed_members_and_style_ids_are_typed_and_unique():
    for field, invalid in [("customStyles", ["quiet-card", "quiet-card"]), ("customStyles", ["unsafe selector > *"])]:
        value = metadata()
        value["localOverrides"]["group"][field] = invalid
        assert validate_canvas_metadata(value)
    for field, invalid in [("width", 0), ("height", False), ("children", ["note", "note"]), ("children", [12])]:
        value = metadata()
        value["localOverrides"]["group"]["groupCollapse"][field] = invalid
        assert validate_canvas_metadata(value)
