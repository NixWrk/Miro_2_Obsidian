from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

sys.path.insert(0, str(MIRO_JSON_DIR))

from utils import safe_filename  # noqa: E402
from miro_downloader import (  # noqa: E402
    download_all,
    download_resource_with_redirect,
    read_json,
    write_json,
)


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        *,
        headers: dict[str, str] | None = None,
        body: bytes = b"",
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def iter_content(self, chunk_size: int):
        del chunk_size
        yield self.body


class MiroDownloaderSecurityTests(unittest.TestCase):
    def test_json_io_rejects_nonfinite_values_without_replacing_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.json"
            path.write_text("old-json", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Out of range float"):
                write_json(path, [{"x": float("inf")}])
            self.assertEqual(path.read_text(encoding="utf-8"), "old-json")

            path.write_text('[{"x": NaN}]', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Non-finite JSON"):
                read_json(path)

    def setUp(self) -> None:
        resolver = patch(
            "miro_downloader.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
        )
        resolver.start()
        self.addCleanup(resolver.stop)

    def test_asset_bearer_is_removed_on_cross_origin_redirect(self) -> None:
        responses = [
            FakeResponse(302, headers={"location": "https://r.miro.com/signed/asset"}),
            FakeResponse(200, body=b"asset"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            with patch(
                "miro_downloader.requests.get", side_effect=responses
            ) as request:
                result = download_resource_with_redirect(
                    "https://api.miro.com/v2/boards/board/images/image?redirect=true",
                    target,
                    "secret-token",
                )

            self.assertEqual(result, target)
            self.assertEqual(target.read_bytes(), b"asset")

        self.assertEqual(
            request.call_args_list[0].kwargs["headers"],
            {"Authorization": "Bearer secret-token"},
        )
        self.assertEqual(request.call_args_list[1].kwargs["headers"], {})

    def test_asset_bearer_is_not_sent_to_arbitrary_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            with patch(
                "miro_downloader.requests.get",
                return_value=FakeResponse(200, body=b"asset"),
            ) as request:
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset",
                    target,
                    "secret-token",
                )

        self.assertIsNotNone(result)
        self.assertEqual(request.call_args.kwargs["headers"], {})

    def test_asset_bearer_is_not_sent_to_nonstandard_api_port(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            with patch(
                "miro_downloader.requests.get",
                return_value=FakeResponse(200, body=b"asset"),
            ) as request:
                download_resource_with_redirect(
                    "https://api.miro.com:8443/asset",
                    target,
                    "secret-token",
                )

        self.assertEqual(request.call_args.kwargs["headers"], {})

    def test_asset_download_rejects_insecure_and_local_urls(self) -> None:
        blocked = (
            "http://api.miro.com/asset",
            "https://127.0.0.1/asset",
            "https://localhost/asset",
            "https://user:password@example.test/asset",
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            with patch("miro_downloader.requests.get") as request:
                for url in blocked:
                    with self.subTest(url=url):
                        self.assertIsNone(
                            download_resource_with_redirect(url, target, "secret-token")
                        )
        request.assert_not_called()

    def test_failed_stream_removes_partial_file(self) -> None:
        response = FakeResponse(200)

        def broken_stream(_chunk_size: int):
            yield b"partial"
            raise RuntimeError("stream failed")

        response.iter_content = broken_stream  # type: ignore[method-assign]
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            partial = target.with_suffix(".bin.part")
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset",
                    target,
                    "secret-token",
                    max_retries=0,
                )

            self.assertIsNone(result)
            self.assertFalse(target.exists())
            self.assertFalse(partial.exists())

    def test_empty_http_200_asset_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.png"
            with patch(
                "miro_downloader.requests.get", return_value=FakeResponse(200, body=b"")
            ):
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset.png",
                    target,
                    "token",
                    max_retries=0,
                )
            self.assertIsNone(result)
            self.assertFalse(target.exists())

    def test_html_http_200_asset_is_rejected(self) -> None:
        response = FakeResponse(
            200, headers={"content-type": "text/html"}, body=b"<html>error</html>"
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.png"
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset.png",
                    target,
                    "token",
                    max_retries=0,
                )
            self.assertIsNone(result)
            self.assertFalse(target.exists())

    def test_private_dns_resolution_is_rejected_before_request(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.bin"
            with patch(
                "miro_downloader.socket.getaddrinfo",
                return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
            ):
                with patch("miro_downloader.requests.get") as request:
                    result = download_resource_with_redirect(
                        "https://private.example.test/asset",
                        target,
                        "token",
                    )

        self.assertIsNone(result)
        request.assert_not_called()

    def test_text_response_cannot_pass_as_extensionless_image(self) -> None:
        response = FakeResponse(
            200, headers={"content-type": "text/plain"}, body=b"Access denied"
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset"
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset",
                    target,
                    "token",
                    expected_kind="image",
                    max_retries=0,
                )

            self.assertIsNone(result)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_content_length_mismatch_is_rejected(self) -> None:
        response = FakeResponse(
            200,
            headers={"content-type": "image/png", "content-length": "1000"},
            body=b"\x89PNG\r\n\x1a\n",
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset.png"
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/asset.png",
                    target,
                    "token",
                    expected_kind="image",
                    max_retries=0,
                )

            self.assertIsNone(result)
            self.assertFalse(target.exists())

    def test_expected_html_document_is_accepted(self) -> None:
        response = FakeResponse(
            200, headers={"content-type": "text/html"}, body=b"<html>document</html>"
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "document.html"
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/document",
                    target,
                    "token",
                    expected_kind="document",
                    max_retries=0,
                )

            self.assertEqual(result, target)
            self.assertEqual(target.read_bytes(), b"<html>document</html>")

    def test_content_disposition_supplies_extension_for_octet_stream(self) -> None:
        response = FakeResponse(
            200,
            headers={
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="report.pdf"',
            },
            body=b"%PDF-1.7",
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "document"
            with patch("miro_downloader.requests.get", return_value=response):
                result = download_resource_with_redirect(
                    "https://assets.example.test/document",
                    target,
                    "token",
                    expected_kind="document",
                    max_retries=0,
                )

            self.assertEqual(result, target.with_suffix(".pdf"))
            self.assertEqual(result.read_bytes(), b"%PDF-1.7")

    def test_retry_restarts_at_original_url_after_signed_url_failure(self) -> None:
        origin = "https://api.miro.com/v2/boards/board/images/image?redirect=true"
        responses = [
            FakeResponse(
                302, headers={"location": "https://r.miro.com/signed/expired"}
            ),
            FakeResponse(200, headers={"content-type": "text/plain"}, body=b"expired"),
            FakeResponse(302, headers={"location": "https://r.miro.com/signed/fresh"}),
            FakeResponse(
                200, headers={"content-type": "image/png"}, body=b"\x89PNG\r\n\x1a\n"
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "asset"
            with patch(
                "miro_downloader.requests.get", side_effect=responses
            ) as request:
                with patch("miro_downloader.time.sleep"):
                    result = download_resource_with_redirect(
                        origin,
                        target,
                        "token",
                        expected_kind="image",
                        max_retries=1,
                    )

            self.assertEqual(result, target.with_suffix(".png"))

        self.assertEqual(
            [call.args[0] for call in request.call_args_list],
            [
                origin,
                "https://r.miro.com/signed/expired",
                origin,
                "https://r.miro.com/signed/fresh",
            ],
        )

    def test_download_all_accepts_numeric_item_id(self) -> None:
        resource = {
            "id": 123,
            "type": "image",
            "data": {"imageUrl": "https://example.test/image.png"},
        }

        def download(_url, target, *_args, **_kwargs):
            target.write_bytes(b"image")
            return target

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "image.png"
            with patch(
                "miro_downloader.download_resource_with_redirect",
                side_effect=download,
            ):
                failures = download_all(
                    [resource],
                    Path(tmp),
                    "token",
                    "team",
                    "board",
                    id_to_final_path={"123": target},
                )

        self.assertEqual(failures, [])
        self.assertEqual(resource["local_name"], "image.png")

    def test_safe_filename_rejects_windows_device_names(self) -> None:
        self.assertEqual(safe_filename("CON.txt"), "_CON.txt")
        self.assertEqual(safe_filename(123), "123")
        self.assertEqual(safe_filename("name. "), "name")

    def test_doc_format_only_reads_inside_sidecar_and_preserves_source_files(
        self,
    ) -> None:
        rendered_html: list[str] = []
        fetched_urls: list[str] = []

        def default_url_fetcher(url: str, *_args, **_kwargs):
            fetched_urls.append(url)
            return {"string": b"asset"}

        class FakeHTML:
            def __init__(self, *, string: str, base_url: str, url_fetcher) -> None:
                del base_url
                rendered_html.append(string)
                url_fetcher(internal.resolve().as_uri())
                with self_test.assertRaisesRegex(ValueError, "not allowed"):
                    url_fetcher(external.resolve().as_uri())
                with self_test.assertRaisesRegex(ValueError, "not allowed"):
                    url_fetcher("https://example.test/tracker.png")

            def write_pdf(self, path: str) -> None:
                Path(path).write_bytes(b"pdf")

        with tempfile.TemporaryDirectory() as tmp:
            self_test = self
            root = Path(tmp)
            sidecar = root / "sidecar"
            sidecar.mkdir()
            internal = sidecar / "internal.png"
            external = root / "private.txt"
            internal.write_bytes(b"internal-image")
            external.write_bytes(b"private-data")
            external_uri = external.resolve().as_uri().replace("file:", "file&#58;", 1)
            html = f'<img src="{internal.resolve().as_uri()}"><img src="  {external_uri}  ">'
            resource = {"id": "doc-1", "type": "doc_format", "data": {"html": html}}

            fake_weasyprint = types.SimpleNamespace(
                HTML=FakeHTML, default_url_fetcher=default_url_fetcher
            )
            with patch.dict(sys.modules, {"weasyprint": fake_weasyprint}):
                download_all(
                    [resource],
                    sidecar,
                    "token",
                    "team",
                    "board",
                    id_to_final_path={"doc-1": sidecar / "doc.pdf"},
                )

            self.assertTrue(internal.exists())
            self.assertTrue(external.exists())
            self.assertEqual(external.read_bytes(), b"private-data")
            self.assertIn("data:image/png;base64,", rendered_html[0])
            self.assertNotIn(external.resolve().as_uri(), rendered_html[0])
            self.assertNotIn("private-data", rendered_html[0])
            self.assertEqual(fetched_urls, [internal.resolve().as_uri()])


if __name__ == "__main__":
    unittest.main()
