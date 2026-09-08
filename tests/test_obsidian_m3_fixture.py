from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from tools.obsidian_oracle import stage_m3_fixture as staging


FIXTURE = Path("tools/obsidian_oracle/fixtures/m3-all-features.canvas")


def load_fixture() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_m3_board_covers_m1_m2_and_m3_contracts() -> None:
    document = load_fixture()
    nodes = document["nodes"]
    edges = document["edges"]
    metadata = document["miroCanvas"]
    source = document["miroSource"]

    node_ids = {node["id"] for node in nodes}
    edge_ids = {edge["id"] for edge in edges}
    assert len(node_ids) == len(nodes)
    assert len(edge_ids) == len(edges)
    assert all(edge["fromNode"] in node_ids and edge["toNode"] in node_ids for edge in edges)

    overrides = metadata["localOverrides"]
    assert {
        overrides[node_id]["shape"]["kind"]
        for node_id in (
            "local-rectangle",
            "local-round-rectangle",
            "local-ellipse",
            "local-triangle",
            "local-diamond",
            "local-star",
        )
    } == {"rectangle", "round_rectangle", "ellipse", "triangle", "diamond", "star"}
    assert overrides["local-star"]["rotation"] < 0
    assert overrides["source-shape-node"]["rotation"] == 0
    assert source["items"][1]["geometry"]["rotation"] < 0
    assert metadata["zOrder"].index("z-back") < metadata["zOrder"].index("z-middle") < metadata["zOrder"].index("z-front")

    assert {item["type"] for item in source["items"]} >= {
        "shape",
        "text",
        "sticky_note",
        "frame",
        "document",
        "image",
    }
    assert source["connectors"][0]["type"] == "connector"
    assert any(item.get("subtype") == "future_hexagon" for item in source["items"])
    assert {anchor["type"] for anchor in metadata["freeAnchors"].values()} == {
        "free",
        "node",
        "image",
        "edge",
    }
    assert any(comment["replies"] for comment in metadata["localComments"])
    assert {comment["resolved"] for comment in metadata["localComments"]} == {False, True}
    assert overrides["edge-node-anchor"]["connectorAnchors"]["to"]["type"] == "edge"
    assert overrides["edge-image-anchor"]["connectorAnchors"]["to"]["type"] == "image"
    assert metadata["settings"]["reviewMode"] is False
    assert overrides["locked-item"]["locked"] is True

    assert document["futureRootField"]["sentinel"] == "keep-root"
    assert metadata["futureMetadataField"]["sentinel"] == "keep-metadata"
    assert source["futureSourceField"]["sentinel"] == "keep-source-root"
    assert source["items"][0]["futureSourceItemField"]["sentinel"] == "keep-source-shape"


def test_m3_staging_is_local_idempotent_and_preserves_manual_edits(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    (vault / ".obsidian").mkdir(parents=True)
    config = {"vault_path": str(vault), "work_folder": "Smoke", "oracle_subfolder": "checks"}
    with patch.object(staging, "load_config", return_value=config):
        canvas = staging.stage_m3_fixture()
        document = json.loads(canvas.read_text(encoding="utf-8"))
        file_nodes = [node for node in document["nodes"] if node.get("type") == "file"]
        assert {Path(node["file"]).suffix for node in file_nodes} == {".md", ".svg"}
        assert all(node["file"].startswith("Smoke/checks/") for node in file_nodes)
        assert all((vault / node["file"]).is_file() for node in file_nodes)

        canvas.write_text('{"nodes":[],"edges":[],"manual":true}', encoding="utf-8")
        staged_assets = [vault / node["file"] for node in file_nodes]
        staged_assets[0].write_text("Manual edit", encoding="utf-8")
        staging.stage_m3_fixture()

    assert json.loads(canvas.read_text(encoding="utf-8"))["manual"] is True
    assert staged_assets[0].read_text(encoding="utf-8") == "Manual edit"
