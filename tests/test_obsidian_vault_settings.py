from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from obsidian_vault_settings import find_vault_root, resolve_vault_paths  # noqa: E402


class ObsidianVaultSettingsTests(unittest.TestCase):
    def test_resolves_attachment_folder_path_from_obsidian_app_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            canvas_folder = vault / "Projects" / "Miro"
            obsidian = vault / ".obsidian"
            obsidian.mkdir(parents=True)
            canvas_folder.mkdir(parents=True)
            (obsidian / "app.json").write_text(
                json.dumps({"attachmentFolderPath": "Files/Attachments"}),
                encoding="utf-8",
            )

            paths = resolve_vault_paths(canvas_folder)

        self.assertEqual(paths.vault_root, vault.resolve())
        self.assertEqual(
            paths.attachment_dir, vault.resolve() / "Files" / "Attachments"
        )

    def test_current_folder_attachment_setting_uses_canvas_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            canvas_folder = vault / "Miro"
            obsidian = vault / ".obsidian"
            obsidian.mkdir(parents=True)
            canvas_folder.mkdir(parents=True)
            (obsidian / "app.json").write_text(
                json.dumps({"newFileLocation": "current"}),
                encoding="utf-8",
            )

            paths = resolve_vault_paths(canvas_folder)

        self.assertEqual(paths.attachment_dir, canvas_folder.resolve())

    def test_find_vault_root_walks_upwards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            nested = vault / "a" / "b"
            (vault / ".obsidian").mkdir(parents=True)
            nested.mkdir(parents=True)

            self.assertEqual(find_vault_root(nested), vault.resolve())

    def test_attachment_folder_cannot_escape_vault(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            canvas_folder = vault / "Miro"
            obsidian = vault / ".obsidian"
            obsidian.mkdir(parents=True)
            canvas_folder.mkdir(parents=True)
            (obsidian / "app.json").write_text(
                json.dumps({"attachmentFolderPath": "../outside"}),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "escapes the vault"):
                resolve_vault_paths(canvas_folder)

    def test_attachment_folder_must_be_vault_relative(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault = root / "vault"
            canvas_folder = vault / "Miro"
            obsidian = vault / ".obsidian"
            obsidian.mkdir(parents=True)
            canvas_folder.mkdir(parents=True)
            (obsidian / "app.json").write_text(
                json.dumps({"attachmentFolderPath": str(root / "outside")}),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "vault-relative"):
                resolve_vault_paths(canvas_folder)


if __name__ == "__main__":
    unittest.main()
