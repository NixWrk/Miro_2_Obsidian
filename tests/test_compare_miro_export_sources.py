from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from audit_web_board_pipeline import BoardRef  # noqa: E402
from compare_miro_export_sources import (  # noqa: E402
    DEFAULT_BOARD_LIST,
    LEGACY_EXP,
    MERGED_REST_EXP_WEBSDK,
    REST_EXP,
    REST_EXP_NO_ASSETS,
    WEBSDK,
    SourceResult,
    choose_best_records,
    expand_source_keys,
    find_websdk_export,
    materialize_source,
    preflight_report,
    refresh_board_list,
    render_recommendations,
    source_keys_require_token,
)


class CompareMiroExportSourcesTests(unittest.TestCase):
    def test_default_board_list_uses_curated_web_boards(self) -> None:
        self.assertEqual(DEFAULT_BOARD_LIST.name, "Web_boards.md")
        self.assertIn("Obs_Miro", str(DEFAULT_BOARD_LIST))
        self.assertIn("Концепт", str(DEFAULT_BOARD_LIST))

    def test_expand_source_keys_adds_merge_dependencies_once(self) -> None:
        self.assertEqual(
            expand_source_keys(MERGED_REST_EXP_WEBSDK),
            [REST_EXP, WEBSDK, MERGED_REST_EXP_WEBSDK],
        )
        expanded = expand_source_keys(f"{REST_EXP},{MERGED_REST_EXP_WEBSDK}")
        self.assertEqual(expanded, [REST_EXP, WEBSDK, MERGED_REST_EXP_WEBSDK])

    def test_find_websdk_export_matches_board_metadata(self) -> None:
        board = BoardRef(board_id="uXjVWebSdk=", label="Web SDK", url="https://miro.com/app/board/uXjVWebSdk=/")

        with tempfile.TemporaryDirectory(prefix="miro2obs_websdk_find_") as tmp:
            root = Path(tmp)
            path = root / "manual-export.json"
            path.write_text(
                json.dumps(
                    {
                        "source_surface": "web_sdk",
                        "board": {"id": "uXjVWebSdk="},
                        "items": [],
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(find_websdk_export(board, root), path)

    def test_materialize_rest_no_assets_writes_canonical_source_without_download(self) -> None:
        board = BoardRef(board_id="uXjVRest=", label="REST", url="https://miro.com/app/board/uXjVRest=/")
        items = [{"id": "text-1", "type": "text"}]
        comments = [{"id": "comment-1", "type": "comment"}]

        with tempfile.TemporaryDirectory(prefix="miro2obs_source_compare_") as tmp:
            out_dir = Path(tmp)
            with (
                patch("compare_miro_export_sources.export_board_items", return_value=items) as export_items,
                patch("compare_miro_export_sources.export_board_comments", return_value=comments) as export_comments,
                patch("compare_miro_export_sources.download_export_assets") as assets,
            ):
                result = materialize_source(
                    board,
                    REST_EXP_NO_ASSETS,
                    out_dir=out_dir,
                    token="token-1",
                    websdk_root=out_dir / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )

            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))

        self.assertEqual(result.status, "exported")
        self.assertEqual(payload, {"items": items, "comments": comments})
        self.assertTrue(export_items.call_args.kwargs["prefer_experimental"])
        export_comments.assert_called_once()
        assets.assert_not_called()
        self.assertFalse(result.export_info["download_assets"])

    def test_materialize_merged_preserves_rest_comments_and_asset_sidecar(self) -> None:
        board = BoardRef(board_id="uXjVMerge=", label="Merge", url="https://miro.com/app/board/uXjVMerge=/")

        with tempfile.TemporaryDirectory(prefix="miro2obs_source_merge_") as tmp:
            root = Path(tmp)
            rest_json = root / "rest.json"
            rest_json.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "id": "text-1",
                                "type": "text",
                                "data": {"content": "<p>REST</p>"},
                                "local_name": "asset.png",
                            }
                        ],
                        "comments": [{"id": "comment-1", "type": "comment", "content": "Nice"}],
                    }
                ),
                encoding="utf-8",
            )
            rest_files = rest_json.with_name("rest_files")
            rest_files.mkdir()
            (rest_files / "asset.png").write_bytes(b"asset")

            websdk_json = root / "websdk.json"
            websdk_json.write_text(
                json.dumps(
                    {
                        "source_surface": "web_sdk",
                        "items": [
                            {"id": "text-1", "type": "text", "content": "REST"},
                            {
                                "id": "mindmap-1",
                                "type": "mindmap_node",
                                "content": "Only Web SDK",
                                "x": 10,
                                "y": 20,
                                "width": 100,
                                "height": 40,
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            exported = {
                REST_EXP: SourceResult(REST_EXP, rest_json, "exported", {}),
                WEBSDK: SourceResult(WEBSDK, websdk_json, "exported", {}),
            }

            result = materialize_source(
                board,
                MERGED_REST_EXP_WEBSDK,
                out_dir=root / "out",
                token="token-1",
                websdk_root=root / "unused",
                allow_missing_assets=False,
                exported=exported,
            )
            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))
            sidecar = Path(result.source_json).with_name("board_files")
            sidecar_file_exists = (sidecar / "asset.png").is_file()

            item_ids = {item["id"] for item in payload["items"]}

        self.assertEqual(payload["comments"], [{"id": "comment-1", "type": "comment", "content": "Nice"}])
        self.assertEqual(item_ids, {"text-1", "mindmap-1"})
        self.assertTrue(sidecar_file_exists)

    def test_legacy_unicode_stdout_error_is_nonfatal_when_json_exists(self) -> None:
        board = BoardRef(board_id="uXjVLegacy=", label="Legacy", url="https://miro.com/app/board/uXjVLegacy=/")

        def fake_run_download(**kwargs):
            save_base = kwargs["save_base"]
            safe_team = kwargs["safe_team"]
            safe_board = kwargs["safe_board"]
            output = save_base / f"{safe_team}_{safe_board}.json"
            output.write_text(json.dumps([{"id": "text-1", "type": "text"}]), encoding="utf-8")
            raise UnicodeEncodeError("charmap", "💾", 0, 1, "boom")

        with tempfile.TemporaryDirectory(prefix="miro2obs_legacy_unicode_") as tmp:
            root = Path(tmp)
            with patch("download_worker.run_download", side_effect=fake_run_download):
                result = materialize_source(
                    board,
                    LEGACY_EXP,
                    out_dir=root,
                    token="token-1",
                    websdk_root=root / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )
            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))

        self.assertEqual(result.status, "exported")
        self.assertEqual(payload, [{"id": "text-1", "type": "text"}])
        self.assertIn("legacy_stdout_encoding_error_ignored", result.export_info["warning"])

    def test_recommendation_prefers_simple_rest_when_quality_ties(self) -> None:
        board = {"board_id": "uXjVRec=", "label": "Rec", "url": "https://miro.com/app/board/uXjVRec=/"}
        records = [
            {
                "board": board,
                "source_key": MERGED_REST_EXP_WEBSDK,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_assets": {"missing": 0},
                "source": {"items": 2},
            },
            {
                "board": board,
                "source_key": REST_EXP,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_assets": {"missing": 0},
                "source": {"items": 1},
            },
        ]

        self.assertEqual(choose_best_records(records)[0]["source_key"], REST_EXP)

    def test_recommendation_chooses_merged_when_it_is_cleaner(self) -> None:
        board = {"board_id": "uXjVRec=", "label": "Rec", "url": "https://miro.com/app/board/uXjVRec=/"}
        records = [
            {
                "board": board,
                "source_key": REST_EXP,
                "text_style_mode": "obsidian",
                "status": "needs_review",
                "missing_miro_items": {"actionable": 1},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_assets": {"missing": 0},
                "source": {"items": 1},
            },
            {
                "board": board,
                "source_key": MERGED_REST_EXP_WEBSDK,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_assets": {"missing": 0},
                "source": {"items": 2},
            },
        ]
        payload = {"summary": {}, "records": records}

        best = choose_best_records(records)[0]
        report = render_recommendations(payload)

        self.assertEqual(best["source_key"], MERGED_REST_EXP_WEBSDK)
        self.assertIn("Merged REST experimental + Web SDK", report)

    def test_source_keys_require_token_for_rest_and_legacy_sources(self) -> None:
        self.assertTrue(source_keys_require_token([REST_EXP]))
        self.assertFalse(source_keys_require_token([WEBSDK]))

    def test_preflight_creates_runtime_dirs_and_masks_oauth_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_preflight_") as tmp:
            root = Path(tmp)
            args = Namespace(
                board_list=root / "lists" / "boards.json",
                websdk_root=root / "websdk",
                out_dir=root / "out",
                token_env="NO_SUCH_MIRO_TOKEN_FOR_TEST",
                oauth_client_id_env="MIRO_CLIENT_ID",
                oauth_client_secret_env="MIRO_CLIENT_SECRET",
                oauth_redirect_uri="http://localhost:8765/callback",
                oauth_scopes="boards:read team:read",
                oauth_authorize_url="https://miro.example/authorize",
                oauth_token_url="https://miro.example/token",
            )
            fake_config = SimpleNamespace(
                client_id="1234567890",
                client_secret="secret",
                redirect_uri=args.oauth_redirect_uri,
                scopes=args.oauth_scopes,
            )

            with (
                patch.dict(os.environ, {}, clear=False),
                patch("compare_miro_export_sources.config_from_env", return_value=fake_config),
            ):
                payload = preflight_report(args, [REST_EXP, WEBSDK])
            lists_dir_exists = (root / "lists").is_dir()
            websdk_dir_exists = (root / "websdk").is_dir()
            out_dir_exists = (root / "out").is_dir()

        self.assertFalse(payload["ready"])
        self.assertEqual(payload["auth"]["oauth"]["client_id"], "******7890")
        self.assertTrue(payload["auth"]["oauth"]["client_secret_present"])
        self.assertTrue(lists_dir_exists)
        self.assertTrue(websdk_dir_exists)
        self.assertTrue(out_dir_exists)
        self.assertIn("Run with --refresh-board-list --oauth", payload["next_steps"][0])

    def test_refresh_board_list_writes_miro_board_payload(self) -> None:
        boards = [
            {"id": "uXjVOne=", "name": "One", "team": {"name": "Alpha"}},
            {"id": "uXjVTwo=", "name": "Two", "team": {"name": "Alpha"}},
        ]

        with tempfile.TemporaryDirectory(prefix="miro2obs_refresh_boards_") as tmp:
            output = Path(tmp) / "boards.json"
            with patch("compare_miro_export_sources.get_boards", return_value=boards) as get_boards:
                summary = refresh_board_list(output, token="token-1")
            payload = json.loads(output.read_text(encoding="utf-8"))

        get_boards.assert_called_once_with("token-1")
        self.assertEqual(summary, {"total": 2, "by_team": {"Alpha": 2}})
        self.assertEqual(payload["source"], "miro_rest_boards")
        self.assertEqual([board["id"] for board in payload["boards"]], ["uXjVOne=", "uXjVTwo="])


if __name__ == "__main__":
    unittest.main()
