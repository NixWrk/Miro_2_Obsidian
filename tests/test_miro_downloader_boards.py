from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

sys.path.insert(0, str(MIRO_JSON_DIR))

from miro_downloader import get_boards  # noqa: E402


class _Response:
    def __init__(
        self,
        payload: dict,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self.payload


class MiroDownloaderBoardsTests(unittest.TestCase):
    def test_get_boards_preserves_full_board_payload_and_pagination(self) -> None:
        responses = [
            _Response(
                {
                    "data": [
                        {
                            "id": "board-1",
                            "name": "One",
                            "team": {"name": "Team A"},
                            "project": {"name": "Project X"},
                            "createdAt": "2026-01-01T00:00:00Z",
                        }
                    ],
                    "links": {"next": "https://api.miro.com/v2/boards?cursor=next"},
                }
            ),
            _Response({"data": [{"id": "board-2", "name": "Two"}], "links": {}}),
        ]

        with patch("miro_downloader.requests.get", side_effect=responses) as request:
            with patch("miro_downloader.time.sleep"):
                boards = get_boards("token-1")

        self.assertEqual([board["id"] for board in boards], ["board-1", "board-2"])
        self.assertEqual(boards[0]["project"]["name"], "Project X")
        self.assertEqual(boards[0]["createdAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(boards[1]["team"], {})
        self.assertEqual(request.call_args_list[0].args[0], "https://api.miro.com/v2/boards?limit=50")
        self.assertEqual(request.call_args_list[1].args[0], "https://api.miro.com/v2/boards?cursor=next")



    def test_get_boards_uses_offset_when_total_proves_more_pages(self) -> None:
        responses = [
            _Response({"data": [{"id": "board-1"}], "total": 2, "offset": 0, "size": 1}),
            _Response({"data": [{"id": "board-2"}], "total": 2, "offset": 1, "size": 1}),
        ]

        with patch("miro_downloader.requests.get", side_effect=responses) as request:
            with patch("miro_downloader.time.sleep"):
                boards = get_boards("token-1")

        self.assertEqual([board["id"] for board in boards], ["board-1", "board-2"])
        self.assertIn("offset=1", request.call_args_list[1].args[0])

    def test_get_boards_fails_when_total_requires_progress_but_page_is_empty(self) -> None:
        response = _Response({"data": [], "total": 1, "offset": 0, "size": 0})
        with patch("miro_downloader.requests.get", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "made no progress"):
                get_boards("token-1")

    def test_get_boards_retries_transient_response(self) -> None:
        responses = [
            _Response({}, status_code=429, headers={"Retry-After": "0"}),
            _Response({"data": [{"id": "board-1"}], "total": 1, "offset": 0, "size": 1}),
        ]
        with patch("miro_downloader.requests.get", side_effect=responses) as request:
            with patch("miro_downloader.time.sleep"):
                boards = get_boards("token-1")

        self.assertEqual([board["id"] for board in boards], ["board-1"])
        self.assertEqual(request.call_count, 2)

    def test_get_boards_rejects_offset_that_does_not_match_request(self) -> None:
        response = _Response({"data": [{"id": "board-1"}], "total": 1, "offset": 1, "size": 1})
        with patch("miro_downloader.requests.get", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "offset does not match"):
                get_boards("token-1")

    def test_get_boards_rejects_boolean_pagination_metadata(self) -> None:
        response = _Response({"data": [{"id": "board-1"}], "total": True, "offset": 0, "size": 1})
        with patch("miro_downloader.requests.get", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "malformed total"):
                get_boards("token-1")
    def test_get_boards_rejects_cross_origin_next_before_sending_token(self) -> None:
        response = _Response(
            {
                "data": [{"id": "board-1", "name": "One"}],
                "links": {"next": "https://attacker.invalid/steal"},
            }
        )

        with patch("miro_downloader.requests.get", return_value=response) as request:
            with patch("miro_downloader.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "left api.miro.com"):
                    get_boards("secret-token")

        request.assert_called_once()
if __name__ == "__main__":
    unittest.main()
