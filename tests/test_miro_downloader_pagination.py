from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

from Miro_2_Json.miro_downloader import get_items_on_board  # noqa: E402


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
