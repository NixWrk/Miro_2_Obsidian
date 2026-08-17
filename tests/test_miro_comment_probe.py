from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_comment_probe import (  # noqa: E402
    CommentProbeError,
    build_comment_probe_requests,
    classify_status,
    decide_probe_result,
    extract_comment_items,
    main,
    run_comment_probe,
)


class FakeResponse:
    def __init__(self, payload: object, *, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self) -> object:
        return self.payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[dict] = []
        self.headers: dict[str, str] = {}

    def get(self, url: str, *, params: dict, headers: dict, timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        return self.responses.pop(0)


class MiroCommentProbeTests(unittest.TestCase):
    def test_build_requests_checks_public_and_experimental_paths(self) -> None:
        requests = build_comment_probe_requests(
            "board-1",
            base_url="https://example.invalid/v2",
            experimental_base_url="https://example.invalid/v2-experimental",
        )

        self.assertEqual([request["key"] for request in requests], [
            "public_items_type_comment",
            "public_comments_collection",
            "experimental_comments_collection",
        ])
        self.assertEqual(requests[0]["params"]["type"], "comment")
        self.assertTrue(requests[1]["url"].endswith("/v2/boards/board-1/comments"))
        self.assertTrue(requests[2]["url"].endswith("/v2-experimental/boards/board-1/comments"))

    def test_classifies_status_codes(self) -> None:
        self.assertEqual(classify_status(200), "available")
        self.assertEqual(classify_status(400), "unsupported_or_bad_request")
        self.assertEqual(classify_status(403), "auth_or_scope_blocked")
        self.assertEqual(classify_status(404), "not_found_or_endpoint_absent")
        self.assertEqual(classify_status(429), "rate_limited")
        self.assertEqual(classify_status(503), "server_error")

    def test_decides_empty_available_source_separately_from_items(self) -> None:
        self.assertEqual(decide_probe_result(0, 0), "separate_source_not_found_in_checked_rest_paths")
        self.assertEqual(decide_probe_result(1, 0), "comments_source_available_empty")
        self.assertEqual(decide_probe_result(1, 2), "comments_available_with_items")

    def test_extracts_comment_items_from_available_response(self) -> None:
        comments = extract_comment_items(
            [
                {
                    "key": "experimental_comments_collection",
                    "classification": "available",
                    "body": {"data": [{"id": "comment-1", "content": "Hello"}]},
                }
            ]
        )

        self.assertEqual(comments[0]["id"], "comment-1")
        self.assertEqual(comments[0]["type"], "comment")
        self.assertEqual(comments[0]["source"], "experimental_comments_collection")

    def test_public_items_probe_does_not_relabel_regular_items_as_comments(self) -> None:
        comments = extract_comment_items(
            [
                {
                    "key": "public_items_type_comment",
                    "classification": "available",
                    "body": {"data": [{"id": "shape-1", "type": "shape"}]},
                }
            ]
        )

        self.assertEqual(comments, [])

    def test_empty_public_items_filter_does_not_prove_comment_availability(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=200),
            FakeResponse({"error": "Not found."}, status_code=404),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        payload = run_comment_probe(
            board_id="board-1",
            token="secret-token",
            session=session,
            retry_delay_seconds=0,
        )

        self.assertEqual(payload["summary"]["available"], 0)
        self.assertEqual(
            payload["summary"]["by_classification"]["unverified_empty_comment_filter"],
            1,
        )
        self.assertFalse(payload["completeness"]["complete"])

    def test_probe_rejects_cross_origin_pagination_link(self) -> None:
        session = FakeSession([
            FakeResponse({"message": "invalid type"}, status_code=400),
            FakeResponse(
                {
                    "data": [{"id": "comment-1", "text": "First"}],
                    "links": {"next": "https://attacker.invalid/steal"},
                },
                status_code=200,
            ),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        with self.assertRaisesRegex(CommentProbeError, "changed origin"):
            run_comment_probe(
                board_id="board-1",
                token="secret-token",
                session=session,
                retry_delay_seconds=0,
            )
        self.assertEqual(len(session.calls), 3)

    def test_probe_records_unavailable_comment_paths(self) -> None:
        session = FakeSession([
            FakeResponse({"message": "invalid type"}, status_code=400),
            FakeResponse({"error": "Not found."}, status_code=404),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        payload = run_comment_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["available"], 0)
        self.assertEqual(payload["decision"], "separate_source_not_found_in_checked_rest_paths")
        self.assertEqual(payload["summary"]["comment_items"], 0)
        self.assertEqual(payload["summary"]["by_classification"]["not_found_or_endpoint_absent"], 2)
        self.assertNotIn("secret-token", str(payload))
        self.assertEqual(session.calls[0]["headers"]["Authorization"], "Bearer secret-token")

    def test_probe_marks_available_payload(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": [{"id": "comment-1", "text": "Hello"}]}, status_code=200),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        payload = run_comment_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["available"], 1)
        self.assertEqual(payload["summary"]["comment_items"], 1)
        self.assertEqual(payload["decision"], "comments_available_with_items")
        self.assertEqual(payload["comments"][0]["id"], "comment-1")

    def test_probe_follows_available_comments_pagination(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse(
                {
                    "data": [{"id": "comment-1", "text": "First"}],
                    "links": {"next": "https://api.miro.com/v2/boards/board-1/comments?cursor=2"},
                },
                status_code=200,
            ),
            FakeResponse({"error": "Not found."}, status_code=404),
            FakeResponse({"data": [{"id": "comment-2", "text": "Second"}]}, status_code=200),
        ])

        payload = run_comment_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual([comment["id"] for comment in payload["comments"]], ["comment-1", "comment-2"])
        self.assertEqual(payload["summary"]["comment_items"], 2)
        self.assertEqual(len(session.calls), 4)
        self.assertIn("cursor=2", session.calls[-1]["url"])
        self.assertIn("pages", payload["requests"][1])

    def test_probe_rejects_page_size_that_disagrees_with_data(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": [{"id": "comment-1"}], "size": 2, "total": 2}, status_code=200),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        with self.assertRaisesRegex(CommentProbeError, "size does not match"):
            run_comment_probe(board_id="board-1", token="secret-token", session=session)

    def test_probe_rejects_boolean_pagination_metadata(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"data": [{"id": "comment-1"}], "total": True}, status_code=200),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        with self.assertRaisesRegex(CommentProbeError, "malformed total"):
            run_comment_probe(board_id="board-1", token="secret-token", session=session)

    def test_probe_rejects_total_that_changes_between_pages(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse(
                {
                    "data": [{"id": "comment-1"}],
                    "size": 1,
                    "offset": 0,
                    "total": 2,
                    "links": {"next": "https://api.miro.com/v2/boards/board-1/comments?cursor=2"},
                },
                status_code=200,
            ),
            FakeResponse({"error": "Not found."}, status_code=404),
            FakeResponse(
                {"data": [{"id": "comment-2"}], "size": 1, "offset": 1, "total": 3},
                status_code=200,
            ),
        ])

        with self.assertRaisesRegex(CommentProbeError, "total changed"):
            run_comment_probe(board_id="board-1", token="secret-token", session=session)
    def test_probe_marks_empty_available_source(self) -> None:
        session = FakeSession([
            FakeResponse({"data": []}, status_code=400),
            FakeResponse({"detail": "Validation failure"}, status_code=400),
            FakeResponse({"data": []}, status_code=200),
        ])

        payload = run_comment_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["available"], 1)
        self.assertEqual(payload["summary"]["comment_items"], 0)
        self.assertEqual(payload["decision"], "comments_source_available_empty")
        self.assertEqual(payload["comments"], [])

    def test_cli_writes_probe_output_without_printing_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "comment_probe.json"
            with patch("scripts.miro_comment_probe.resolve_token_from_args", return_value="secret-token"):
                with patch(
                    "scripts.miro_comment_probe.run_comment_probe",
                    return_value={
                        "kind": "miro_comment_source_probe",
                        "summary": {"checked": 3, "available": 0, "comment_items": 0},
                        "decision": "separate_source_not_found_in_checked_rest_paths",
                        "requests": [],
                        "comments": [],
                    },
                ):
                    with patch.object(sys, "argv", ["scripts.miro_comment_probe.py", "--board-id", "board-1", "--output", str(output)]):
                        self.assertEqual(main(), 0)

            text = output.read_text(encoding="utf-8")
            self.assertIn("miro_comment_source_probe", text)
            self.assertNotIn("secret-token", text)


if __name__ == "__main__":
    unittest.main()
