from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


TOOL_DIR = Path(__file__).resolve().parent
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


SAMPLE_CANVAS = {
    "nodes": [
        {
            "id": "text-1",
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 180,
            "height": 80,
            "text": "<p>Smoke text</p>",
        },
        {
            "id": "link-1",
            "type": "link",
            "x": 260,
            "y": 0,
            "width": 240,
            "height": 135,
            "url": "https://example.com",
        },
    ],
    "edges": [
        {
            "id": "edge-1",
            "fromNode": "text-1",
            "toNode": "link-1",
        }
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def copy_renderer(target_dir: Path) -> None:
    for name in ("index.html", "render.js", "styles.css"):
        shutil.copy2(TOOL_DIR / name, target_dir / name)
    (target_dir / "sample.canvas").write_text(
        json.dumps(SAMPLE_CANVAS, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def run_server(root: Path) -> tuple[ThreadingHTTPServer, int]:
    class Handler(QuietHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=str(root), **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = int(server.server_address[1])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def run_edge(url: str, edge_path: Path) -> str:
    if not edge_path.exists():
        raise SystemExit(f"Edge executable not found: {edge_path}")

    result = subprocess.run(
        [
            str(edge_path),
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--disable-extensions",
            "--virtual-time-budget=5000",
            "--dump-dom",
            url,
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout


def run_playwright(url: str) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1000, "height": 700}, device_scale_factor=1)
        try:
            page.goto(url)
            page.wait_for_function(
                "document.body.dataset.renderStatus === 'ready'",
                timeout=5000,
            )
            return page.content()
        finally:
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Headless smoke test for the diagnostic canvas renderer.")
    parser.add_argument("--edge", default=str(EDGE_PATH), help="Path to msedge.exe")
    parser.add_argument(
        "--browser",
        choices=("playwright", "edge"),
        default="playwright",
        help="Headless browser runner to use.",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="canvas_render_smoke_") as tmp:
        root = Path(tmp)
        copy_renderer(root)
        server, port = run_server(root)
        try:
            url = f"http://127.0.0.1:{port}/index.html?canvas=/sample.canvas"
            dom = run_edge(url, Path(args.edge)) if args.browser == "edge" else run_playwright(url)
        finally:
            server.shutdown()

    required = [
        'data-render-status="ready"',
        'data-node-count="2"',
        'data-edge-count="1"',
        "Rendered successfully.",
        "Smoke text",
        "https://example.com",
    ]
    missing = [needle for needle in required if needle not in dom]
    if missing:
        raise SystemExit(f"Renderer smoke test failed, missing: {missing}")

    print("OK: diagnostic canvas renderer smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
