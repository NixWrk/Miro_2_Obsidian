from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_comment_probe import (  # noqa: E402
    build_comment_probe_requests,
    classify_status,
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

    def test_probe_records_unavailable_comment_paths(self) -> None:
        session = FakeSession([
            FakeResponse({"message": "invalid type"}, status_code=400),
            FakeResponse({"error": "Not found."}, status_code=404),
            FakeResponse({"error": "Not found."}, status_code=404),
        ])

        payload = run_comment_probe(board_id="board-1", token="secret-token", session=session)

        self.assertEqual(payload["summary"]["available"], 0)
        self.assertEqual(payload["decision"], "separate_source_not_found_in_checked_rest_paths")
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
        self.assertEqual(payload["decision"], "comments_available")
        self.assertEqual(payload["requests"][1]["body"]["data"][0]["id"], "comment-1")

    def test_cli_writes_probe_output_without_printing_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "comment_probe.json"
            with patch("miro_comment_probe.resolve_token_from_args", return_value="secret-token"):
                with patch(
                    "miro_comment_probe.run_comment_probe",
                    return_value={
                        "kind": "miro_comment_source_probe",
                        "summary": {"checked": 3, "available": 0},
                        "decision": "separate_source_not_found_in_checked_rest_paths",
                        "requests": [],
                    },
                ):
                    with patch.object(sys, "argv", ["miro_comment_probe.py", "--board-id", "board-1", "--output", str(output)]):
                        self.assertEqual(main(), 0)

            text = output.read_text(encoding="utf-8")
            self.assertIn("miro_comment_source_probe", text)
            self.assertNotIn("secret-token", text)


if __name__ == "__main__":
    unittest.main()
