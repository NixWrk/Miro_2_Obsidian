from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

from Miro_2_Json.miro_downloader import _dedupe_miro_items, get_items_on_board  # noqa: E402


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.status_code = 200
        self.reason = "OK"
        self.text = str(payload)

    def json(self) -> object:
        return self.payload

    def raise_for_status(self) -> None:
        return None


class FakeSession:
    def __init__(self, payloads: list[object]) -> None:
        self.payloads = list(payloads)
        self.headers: dict[str, str] = {}
        self.calls: list[tuple[str, dict[str, str]]] = []

    def mount(self, *_args) -> None:
        return None

    def get(self, url: str, params: dict[str, str] | None = None, timeout: int = 30) -> FakeResponse:
        del timeout
        self.calls.append((url, dict(params or {})))
        return FakeResponse(self.payloads.pop(0))


class MiroDownloaderPaginationTests(unittest.TestCase):
    def test_tag_membership_next_links_keep_the_filter(self) -> None:
        for next_query in ("cursor=next", "cursor=next&tag_id=other"):
            with self.subTest(next_query=next_query):
                session = FakeSession([
                    {"data": []}, {"data": []}, {"data": [{"id": "tag-1"}]},
                    *({"data": []} for _ in range(5)), {"id": "board-1"},
                    {"data": [{"id": "text-1", "type": "text"}], "total": 2,
                     "links": {"next": f"https://api.miro.com/v2/boards/board-1/items?{next_query}"}},
                    {"data": [{"id": "text-2", "type": "text"}], "total": 2},
                ])
                with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
                    if "other" in next_query:
                        with self.assertRaisesRegex(RuntimeError, "changed collection filter"):
                            get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False)
                        self.assertEqual(len(session.calls), 10)
                    else:
                        raw = get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False)
                        self.assertEqual(session.calls[10][1], {"tag_id": "tag-1"})
                        self.assertEqual([item["tagIds"] for item in raw if item["type"] == "text"], [["tag-1"], ["tag-1"]])

    def test_full_offset_page_without_total_is_followed(self) -> None:
        session = FakeSession([
            {"data": []}, {"data": []},
            {"data": [{"id": f"tag-{i}"} for i in range(50)]},
            {"data": [{"id": f"tag-{i}"} for i in range(50, 60)]},
            *({"data": []} for _ in range(5)), {"id": "board-1"},
        ])
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            items = get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False, read_details=False)
        self.assertEqual(sum(item["type"] == "tag" for item in items), 60)
        self.assertEqual(session.calls[3][1]["offset"], "50")

    def test_experimental_mindmap_collection_and_detail_are_explicitly_read(self) -> None:
        session = FakeSession([
            {"data": []}, *({"data": []} for _ in range(7)), {"id": "board-1"},
            {"data": [{"id": "mind-1"}], "cursor": "mind-page-2"},
            {"data": [{"id": "mind-2"}]},
            {"id": "mind-1", "data": {"nodeView": {"data": {"content": "first"}}}},
            {"id": "mind-2", "data": {"nodeView": {"data": {"content": "second"}}}},
        ])
        metadata = {}
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            raw = get_items_on_board("board-1", "synthetic-token", metadata=metadata)
        items = {item["id"]: item for item in _dedupe_miro_items(raw)}
        self.assertEqual(items["mind-1"]["type"], "mindmap_node")
        self.assertEqual(items["mind-2"]["data"]["nodeView"]["data"]["content"], "second")
        self.assertEqual(metadata["source_pages"]["mindmap_nodes(v2-experimental)"], 2)
        self.assertTrue(session.calls[9][0].endswith("/v2-experimental/boards/board-1/mindmap_nodes"))
        self.assertEqual(session.calls[10][1]["cursor"], "mind-page-2")

    def test_details_and_memberships_preserve_additional_fields_and_assignments(self) -> None:
        session = FakeSession([
            {"data": [{"id": "text-1", "type": "text", "content": "original"}]},
            {"data": [{"id": "connector-1", "type": "connector"}]},
            {"data": [{"id": "tag-1"}, {"id": "tag-2"}]},
            *({"data": []} for _ in range(3)),
            {"data": [{"id": "group-1"}]}, {"data": []}, {"id": "board-1"},
            {"id": "connector-1", "captions": [{"content": "caption"}], "style": {"strokeColor": "red"}},
            {"id": "group-1", "name": "Group"},
            {"data": [{"id": "text-1"}], "cursor": "next-members"},
            {"data": [{"id": "text-2", "type": "text"}]},
            {"data": [{"id": "text-1"}], "total": 1, "offset": 0},
            {"data": [{"id": "text-1"}], "total": 1, "offset": 0},
        ])
        metadata = {}
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            raw = get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False, metadata=metadata)
        items = {item["id"]: item for item in _dedupe_miro_items(raw)}
        self.assertEqual(items["connector-1"]["captions"][0]["content"], "caption")
        self.assertEqual(items["text-1"]["groupId"], "group-1")
        self.assertEqual(items["text-2"]["groupId"], "group-1")
        self.assertEqual(items["text-1"]["tagIds"], ["tag-1", "tag-2"])
        self.assertEqual(items["text-1"]["content"], "original")
        self.assertEqual(metadata["read_details"]["group_members"]["group-1"], ["text-1", "text-2"])
        self.assertEqual(session.calls[12][1]["group_item_id"], "group-1")
        self.assertEqual(session.calls[13][1]["tag_id"], "tag-1")
        self.assertGreaterEqual(len(items["text-1"]["source_provenance"]["original_items"]), 4)

    def test_details_reject_wrong_identity(self) -> None:
        session = FakeSession([
            {"data": []}, {"data": [{"id": "connector-1"}]},
            *({"data": []} for _ in range(6)), {"id": "board-1"}, {"id": "wrong"},
        ])
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "different item ID"):
                get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False)

    def test_repeated_ids_do_not_satisfy_declared_total(self) -> None:
        session = FakeSession([
            {"data": []}, {"data": []},
            {"data": [{"id": "tag-1"}], "total": 2},
            {"data": [{"id": "tag-1"}], "total": 2, "offset": 1},
        ])
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "repeated item ID"):
                get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False)

    def test_offset_only_tags_capture_all_sixty_records(self) -> None:
        session = FakeSession([
            {"data": []}, {"data": []},
            {"data": [{"id": f"tag-{i}"} for i in range(50)], "offset": 0, "limit": 50, "total": 60},
            {"data": [{"id": f"tag-{i}"} for i in range(50, 60)], "offset": 50, "limit": 50, "total": 60},
            *({"data": []} for _ in range(5)), {"id": "board-1"},
        ])
        metadata = {}
        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            items = get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False, metadata=metadata, read_details=False)
        self.assertEqual(sum(item["type"] == "tag" for item in items), 60)
        self.assertEqual(metadata["source_records"]["tags"], 60)
        self.assertEqual(metadata["source_pages"]["tags"], 2)
        self.assertTrue(metadata["complete"])
        self.assertEqual(session.calls[3][1]["offset"], "50")

    def test_offset_pagination_rejects_inconsistent_evidence(self) -> None:
        bad_pages = [
            {"data": [], "offset": 1, "total": 2},
            {"data": [], "offset": 0, "total": 2},
            {"data": [{"id": "tag-2"}], "offset": 1, "total": 3},
            {"data": [{"id": "tag-2"}], "offset": 1, "total": True},
            {"data": [{"id": "tag-2"}], "offset": 1, "total": 2, "size": 5},
        ]
        for last in bad_pages:
            with self.subTest(last=last):
                session = FakeSession([
                    {"data": []}, {"data": []},
                    {"data": [{"id": "tag-1"}], "offset": 0, "total": 2}, last,
                ])
                with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
                    with self.assertRaisesRegex(RuntimeError, "pagination"):
                        get_items_on_board("board-1", "synthetic-token", prefer_experimental_items=False)

    def test_complete_stable_export_reports_every_endpoint_page(self) -> None:
        collection_payloads = [
            {"data": [{"id": "text-1", "type": "text", "text": {"content": "Hello"}}]},
            *({"data": []} for _ in range(7)),
            {"id": "board-1", "name": "Board"},
        ]
        session = FakeSession(collection_payloads)
        metadata: dict = {}

        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            items = get_items_on_board(
                "board-1",
                "secret-token",
                prefer_experimental_items=False,
                metadata=metadata,
            )

        self.assertTrue(metadata["complete"])
        self.assertEqual(metadata["source_pages"]["items(v2)"], 1)
        self.assertEqual(metadata["source_pages"]["board"], 1)
        self.assertEqual({item["id"] for item in items}, {"text-1", "board-1"})
        self.assertEqual(session.headers["Authorization"], "Bearer secret-token")

    def test_items_pagination_rejects_cross_origin_next_before_request(self) -> None:
        session = FakeSession(
            [
                {
                    "data": [{"id": "text-1", "type": "text"}],
                    "links": {"next": "https://attacker.invalid/steal"},
                }
            ]
        )

        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "left api.miro.com"):
                get_items_on_board("board-1", "secret-token", prefer_experimental_items=False)

        self.assertEqual(len(session.calls), 1)

    def test_items_pagination_rejects_repeated_cursor(self) -> None:
        session = FakeSession(
            [
                {"data": [], "cursor": "same"},
                {"data": [], "cursor": "same"},
            ]
        )

        with patch("Miro_2_Json.miro_downloader.requests.Session", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "repeated the same request"):
                get_items_on_board("board-1", "secret-token", prefer_experimental_items=False)

        self.assertEqual(len(session.calls), 2)


if __name__ == "__main__":
    unittest.main()
