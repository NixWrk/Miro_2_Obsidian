"""Local acceptance check of the installed wheel; uses only synthetic content."""
import argparse
import base64
import itertools
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

for key in list(os.environ):
    if key.startswith("MIRO"):
        del os.environ[key]

parser = argparse.ArgumentParser(description="Check an installed Windows wheel with no Miro connection.")
parser.add_argument("--work-dir", type=Path, required=True, help="Directory for synthetic exports and the JSON report.")
root = parser.parse_args().work_dir.resolve()
root.mkdir(parents=True, exist_ok=True)
os.chdir(root)
os.environ["PATH"] = os.pathsep.join([str(Path(sys.executable).parent), str(Path(os.environ["SystemRoot"]) / "System32")])

import miro2obsidian  # noqa: E402 - first clear inherited Miro configuration
import Miro_2_Obsidian_GUI as gui  # noqa: E402
from miro2obsidian.agent_runner import run_agent  # noqa: E402
from miro2obsidian import gui_support, miro_auth  # noqa: E402
from miro2obsidian.schema import validate_board  # noqa: E402
from miro2obsidian.websdk_server import websdk_directory  # noqa: E402
from scripts.obsidian_plugin_setup import install_zoom_unlock, ZOOM_UNLOCK_SOURCE  # noqa: E402

assert "site-packages" in miro2obsidian.__file__
assert ZOOM_UNLOCK_SOURCE.is_dir(), "wheel omitted the zoom-unlock plugin"
assert (websdk_directory() / "exporter.js").is_file()

source = root / "synthetic.json"
assets = root / "synthetic_files"
assets.mkdir(exist_ok=True)
(assets / "image.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="))
items = [
    {"id": "text-1", "type": "text", "source": "rest_v2", "data": {"content": "<p>Чистая установка: <strong>текст</strong></p>"},
     "position": {"x": 0, "y": 0}, "geometry": {"width": 200, "height": 80}},
    {"id": "image-1", "type": "image", "source": "rest_v2", "local_name": "image.png", "data": {"imageUrl": "https://example.invalid/image.png"},
     "position": {"x": 300, "y": 0}, "geometry": {"width": 100, "height": 100}},
]
requirements = {"images": 1, "documents": 0, "doc_formats": 0, "embeds": 0, "failed": 0, "optional_failed": 0}
payload = {"schema_version": 1, "source_surface": "rest", "export_scope": "board", "exporter_version": "clean-install-test",
           "exported_at": datetime.now(timezone.utc).isoformat(), "board": {"id": "synthetic-board"}, "items": items, "comments": [],
           "provenance": {"board_id": "synthetic-board", "items": {"complete": True, "raw_count": 2, "item_count": 2, "sources": {"rest_v2": 2}},
                          "comments": {"complete": True, "raw_count": 0, "comment_count": 0}, "assets": {"strategy": "synthetic"}},
           "completeness": {"complete": True, "items": {"complete": True}, "comments": {"complete": True},
                            "assets": {"complete": True, "checked": True, "missing": [], "optional_missing": [], "requirements": requirements}}}
source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

cli = Path(sys.executable).parent / "miro2obsidian.exe"
report = {"installation": "wheel, isolated Python, no checkout imports", "offline_conversions": [], "gui_combinations": 0,
          "live_miro": "pending first app setup and user sign-in"}
for fmt, scale_mode, theme, style in itertools.product(
    ["native-canvas", "advanced-canvas", "miro-canvas"], ["balanced", "overview", "readable"], ["dark", "light"], ["miro", "obsidian"]
):
    label = f"{fmt}-{scale_mode}-{theme}-{style}"
    vault = root / "vault"
    target = vault / label
    completed = subprocess.run([str(cli), "--existing-json", "--source-json", str(source), "--vault-root", str(vault),
                                "--target-dir", str(target), "--format", fmt, "--scale-mode", scale_mode, "--theme", theme,
                                "--text-style-mode", style], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    assert completed.returncode == 0, (label, completed.stdout, completed.stderr)
    canvas = json.loads((target / "synthetic.canvas").read_text(encoding="utf-8"))
    assert not validate_board(canvas), label
    assert {"text-1", "image-1"} <= {node["id"] for node in canvas["nodes"]}
    for node in canvas["nodes"]:
        if node["type"] == "file":
            assert (vault / node["file"]).is_file(), node
    report["offline_conversions"].append(label)

install_zoom_unlock(root / "plugin-vault")
assert (root / "plugin-vault/.obsidian/plugins/canvas-zoom-unlock/main.js").is_file()
report["bundled_plugin"] = "installed and hash-verified"

os.environ["MIRO2OBSIDIAN_UI_SETTINGS"] = str(root / "ui.json")
with (
    patch.object(miro_auth, "connection_status", return_value=miro_auth.ConnectionStatus(connected=False)),
    patch.object(gui_support, "settings_path", return_value=root / "setup.json"),
    patch.object(miro_auth, "get_access_token", side_effect=miro_auth.NotConnected("First setup required")),
):
    app = gui.MiroPipelineApp()
    app.withdraw()
    try:
        assert app.workflow_mode._original_values == [gui.MANUAL_WORKFLOW, gui.CODE_WORKFLOW, gui.AGENT_WORKFLOW]
        assert app.workflow_mode.get() == gui.CODE_WORKFLOW
        assert app.output_format.get() == "raw-json"
        assert not app.selected_account_board_id
        for workflow in [gui.MANUAL_WORKFLOW, gui.CODE_WORKFLOW, gui.AGENT_WORKFLOW]:
            app.workflow_mode.set(workflow)
            app.guided.workflow_changed(workflow)
            for source_mode, fmt in itertools.product(
                app.source_mode._original_values,
                ["native-canvas", "advanced-canvas", "miro-canvas", "raw-json"],
            ):
                app.source_mode.set(source_mode)
                app.guided.source_changed(source_mode)
                app.output_format.set(fmt)
                app.guided.format_changed(fmt)
                for language in ("ru", "en"):
                    app.ui.change("language", language)
                    app.update_idletasks()
                    assert app.active_workflow_mode == workflow
                    assert app.source_mode.get() == source_mode
                report["gui_combinations"] += 1
        app.open_miro_setup()
        setup = app._setup_view
        assert len(setup.panels) == 3
        setup.advance()
        setup.advance()
        setup.advance()
        assert "Enter both" in setup.feedback.cget("text")
        assert setup.client_secret.cget("show") == "*"
        setup.close()
        app.open_miro_setup()
        assert app._setup_view.step == 2
        app._setup_view.close()
        report["first_setup"] = "embedded 3-stage setup, blank fields rejected, progress restored"
        try:
            app._token()
        except RuntimeError as exc:
            assert "Set up Miro app" in str(exc)
        else:
            raise AssertionError("Unexpected authorization without setup")
    finally:
        app.destroy()

try:
    with patch("miro2obsidian.agent_runner.start_browser_bridge", side_effect=AssertionError("A missing agent must not open Miro")):
        run_agent(board_url="https://miro.com/app/board/synthetic-board/", target_dir=root / "vault", vault_root=root / "vault",
                  output_format="native-canvas", repo_root=root)
except RuntimeError as exc:
    assert "No agent configured" in str(exc)
    report["agent_without_installation"] = "actionable setup error, no export attempted"
else:
    raise AssertionError("A clean environment unexpectedly found an agent")

(root / "acceptance-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"conversions_passed": len(report["offline_conversions"]), "gui_combinations_passed": report["gui_combinations"],
                  "bundled_plugin": report["bundled_plugin"], "live_miro": report["live_miro"]}))
