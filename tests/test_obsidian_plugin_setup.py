from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from obsidian_plugin_setup import (  # noqa: E402
    ADVANCED_CANVAS_ID,
    ADVANCED_CANVAS_VERSION,
    ZOOM_UNLOCK_ID,
    ZOOM_UNLOCK_VERSION,
    _activate_plugin,
    download_release_asset,
    enable_plugins,
    install_advanced_canvas,
    install_zoom_unlock,
    plugin_has_runtime,
    setup_obsidian_plugins,
)


def runtime_hashes(path: Path) -> dict[str, str]:
    return {
        name: hashlib.sha256((path / name).read_bytes()).hexdigest()
        for name in ("manifest.json", "main.js", "styles.css")
    }


class ObsidianPluginSetupTests(unittest.TestCase):
    def test_setup_enables_existing_advanced_canvas_and_local_zoom_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            advanced = vault / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            advanced.mkdir(parents=True)
            (advanced / "manifest.json").write_text(
                '{"id":"advanced-canvas","version":"6.0.1"}', encoding="utf-8"
            )
            (advanced / "main.js").write_text("// installed\n", encoding="utf-8")
            (advanced / "styles.css").write_text("/* installed */\n", encoding="utf-8")

            with patch.dict(
                "obsidian_plugin_setup.ADVANCED_CANVAS_SHA256",
                {ADVANCED_CANVAS_VERSION: runtime_hashes(advanced)},
                clear=True,
            ):
                result = setup_obsidian_plugins(vault)

            enabled = json.loads(
                (vault / ".obsidian" / "community-plugins.json").read_text(
                    encoding="utf-8"
                )
            )
            zoom = vault / ".obsidian" / "plugins" / ZOOM_UNLOCK_ID
            self.assertTrue(plugin_has_runtime(vault, ADVANCED_CANVAS_ID))
            self.assertTrue((zoom / "manifest.json").is_file())
            self.assertTrue((zoom / "main.js").is_file())
            self.assertIn(ADVANCED_CANVAS_ID, enabled)
            self.assertIn(ZOOM_UNLOCK_ID, enabled)
            self.assertEqual(result.installed, [ADVANCED_CANVAS_ID, ZOOM_UNLOCK_ID])

    def test_zoom_unlock_rejects_unpinned_version_before_activation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "zoom-source"
            source.mkdir()
            (source / "manifest.json").write_text(
                '{"id":"canvas-zoom-unlock","version":"9.9.9"}',
                encoding="utf-8",
            )
            (source / "main.js").write_text("// incompatible\n", encoding="utf-8")
            (source / "styles.css").write_text("/* incompatible */\n", encoding="utf-8")
            vault = root / "vault"

            with patch("obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE", source):
                with self.assertRaisesRegex(
                    RuntimeError, f"manifest version is not {ZOOM_UNLOCK_VERSION}"
                ):
                    install_zoom_unlock(vault)

            target = vault / ".obsidian" / "plugins" / ZOOM_UNLOCK_ID
            self.assertFalse(target.exists())

    def test_zoom_unlock_rejects_hash_mismatch_before_activation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "zoom-source"
            source.mkdir()
            (source / "manifest.json").write_text(
                json.dumps(
                    {
                        "id": "canvas-zoom-unlock",
                        "version": ZOOM_UNLOCK_VERSION,
                    }
                ),
                encoding="utf-8",
            )
            (source / "main.js").write_text("// tampered\n", encoding="utf-8")
            (source / "styles.css").write_text("/* tampered */\n", encoding="utf-8")
            vault = root / "vault"

            with patch("obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE", source):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    install_zoom_unlock(vault)

            target = vault / ".obsidian" / "plugins" / ZOOM_UNLOCK_ID
            self.assertFalse(target.exists())

    def test_setup_can_copy_advanced_canvas_from_existing_plugins_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source_plugins" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text(
                '{"id":"advanced-canvas","version":"6.0.1"}', encoding="utf-8"
            )
            (source / "main.js").write_text("// copied\n", encoding="utf-8")
            (source / "styles.css").write_text("/* copied */\n", encoding="utf-8")
            (root / "vault" / ".obsidian").mkdir(parents=True)

            with patch.dict(
                "obsidian_plugin_setup.ADVANCED_CANVAS_SHA256",
                {ADVANCED_CANVAS_VERSION: runtime_hashes(source)},
                clear=True,
            ):
                setup_obsidian_plugins(
                    root / "vault", advanced_source_plugins_dir=root / "source_plugins"
                )

            target = root / "vault" / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            self.assertEqual(
                (target / "main.js").read_text(encoding="utf-8"), "// copied\n"
            )

    def test_tampered_existing_runtime_is_replaced_by_verified_local_runtime(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source_plugins" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text(
                '{"id":"advanced-canvas","version":"6.0.1"}', encoding="utf-8"
            )
            (source / "main.js").write_text("// verified\n", encoding="utf-8")
            (source / "styles.css").write_text("/* verified */\n", encoding="utf-8")
            vault = root / "vault"
            target = vault / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            target.mkdir(parents=True)
            (target / "manifest.json").write_bytes(
                (source / "manifest.json").read_bytes()
            )
            (target / "main.js").write_text("// tampered\n", encoding="utf-8")
            (target / "styles.css").write_bytes((source / "styles.css").read_bytes())

            with patch.dict(
                "obsidian_plugin_setup.ADVANCED_CANVAS_SHA256",
                {ADVANCED_CANVAS_VERSION: runtime_hashes(source)},
                clear=True,
            ):
                install_advanced_canvas(
                    vault, source_plugins_dir=root / "source_plugins"
                )

            self.assertEqual(
                (target / "main.js").read_text(encoding="utf-8"), "// verified\n"
            )

    def test_local_advanced_canvas_hash_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source_plugins" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text(
                '{"id":"advanced-canvas","version":"6.0.1"}', encoding="utf-8"
            )
            (source / "main.js").write_text("// expected\n", encoding="utf-8")
            (source / "styles.css").write_text("/* expected */\n", encoding="utf-8")
            expected_hashes = runtime_hashes(source)
            (source / "main.js").write_text("// tampered\n", encoding="utf-8")

            with patch.dict(
                "obsidian_plugin_setup.ADVANCED_CANVAS_SHA256",
                {ADVANCED_CANVAS_VERSION: expected_hashes},
                clear=True,
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    install_advanced_canvas(
                        root / "vault", source_plugins_dir=root / "source_plugins"
                    )

    def test_local_advanced_canvas_must_match_requested_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source_plugins" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text(
                '{"id":"advanced-canvas","version":"5.0.0"}', encoding="utf-8"
            )
            (source / "main.js").write_text("// copied\n", encoding="utf-8")
            (source / "styles.css").write_text("/* copied */\n", encoding="utf-8")
            (root / "vault" / ".obsidian").mkdir(parents=True)

            with self.assertRaisesRegex(RuntimeError, "manifest version is not 6.0.1"):
                setup_obsidian_plugins(
                    root / "vault",
                    advanced_source_plugins_dir=root / "source_plugins",
                )

    def test_enable_plugins_keeps_existing_json_when_atomic_replace_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            enabled_path = vault / ".obsidian" / "community-plugins.json"
            enabled_path.parent.mkdir(parents=True)
            enabled_path.write_text('["existing"]\n', encoding="utf-8")

            with patch.object(Path, "replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    enable_plugins(vault, ["new-plugin"])

            self.assertEqual(
                json.loads(enabled_path.read_text(encoding="utf-8")), ["existing"]
            )
            self.assertEqual(
                list(enabled_path.parent.glob(".community-plugins.json.*.tmp")), []
            )

    def test_download_release_asset_tries_plain_and_v_prefixed_tags(self) -> None:
        calls: list[str] = []

        def fake_download(url: str, target: Path) -> None:
            calls.append(url)
            if "/download/6.0.1/" in url:
                raise OSError("missing plain tag")
            target.write_text("asset", encoding="utf-8")

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "main.js"
            with patch("obsidian_plugin_setup._download", side_effect=fake_download):
                url = download_release_asset(
                    "owner/repo",
                    "6.0.1",
                    "main.js",
                    target,
                    expected_sha256=hashlib.sha256(b"asset").hexdigest(),
                )
            text = target.read_text(encoding="utf-8")

        self.assertEqual(len(calls), 2)
        self.assertIn("/download/v6.0.1/main.js", url)
        self.assertEqual(text, "asset")

    def test_download_release_asset_does_not_follow_predictable_hardlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "main.js"
            predictable = root / "main.js.part"
            victim = root / "victim.txt"
            victim.write_text("keep", encoding="utf-8")
            try:
                os.link(victim, predictable)
            except OSError as exc:
                self.skipTest(f"Hardlinks are unavailable: {exc}")

            with patch(
                "obsidian_plugin_setup._download",
                side_effect=lambda _url, path: path.write_bytes(b"asset"),
            ):
                download_release_asset(
                    "owner/repo",
                    "6.0.1",
                    "main.js",
                    target,
                    expected_sha256=hashlib.sha256(b"asset").hexdigest(),
                )

            self.assertEqual(victim.read_text(encoding="utf-8"), "keep")
            self.assertEqual(predictable.read_text(encoding="utf-8"), "keep")
            self.assertEqual(target.read_bytes(), b"asset")

    def test_download_release_asset_rejects_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "main.js"
            with patch(
                "obsidian_plugin_setup._download",
                side_effect=lambda _url, path: path.write_bytes(b"bad"),
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    download_release_asset(
                        "owner/repo",
                        "6.0.1",
                        "main.js",
                        target,
                        expected_sha256=hashlib.sha256(b"good").hexdigest(),
                    )
            self.assertFalse(target.exists())

    def test_activation_verification_failure_restores_previous_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "plugin"
            staged = root / "staged"
            target.mkdir()
            staged.mkdir()
            (target / "main.js").write_text("old", encoding="utf-8")
            (staged / "main.js").write_text("new", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "failed verification"):
                _activate_plugin(
                    staged, target, lambda _path: "corrupted after activation"
                )

            self.assertEqual((target / "main.js").read_text(encoding="utf-8"), "old")

    def test_setup_rejects_invalid_enabled_plugins_before_installing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            settings = vault / ".obsidian" / "community-plugins.json"
            settings.parent.mkdir(parents=True)
            settings.write_text('{"unexpected": true}', encoding="utf-8")

            with patch("obsidian_plugin_setup.install_advanced_canvas") as advanced:
                with patch("obsidian_plugin_setup.install_zoom_unlock") as zoom:
                    with self.assertRaisesRegex(RuntimeError, "JSON array"):
                        setup_obsidian_plugins(vault)

            advanced.assert_not_called()
            zoom.assert_not_called()

    def test_partial_existing_runtime_is_replaced_only_after_staging_succeeds(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault = root / "vault"
            target = vault / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
            target.mkdir(parents=True)
            (target / "manifest.json").write_text(
                '{"id":"advanced-canvas"}', encoding="utf-8"
            )
            (target / "main.js").write_text("// old\n", encoding="utf-8")
            source = root / "source" / ADVANCED_CANVAS_ID
            source.mkdir(parents=True)
            (source / "manifest.json").write_text('{"id":"wrong"}', encoding="utf-8")
            (source / "main.js").write_text("// bad\n", encoding="utf-8")
            (source / "styles.css").write_text("/* bad */\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "Invalid local"):
                setup_obsidian_plugins(
                    vault, advanced_source_plugins_dir=root / "source"
                )

            self.assertEqual(
                (target / "main.js").read_text(encoding="utf-8"), "// old\n"
            )


if __name__ == "__main__":
    unittest.main()
