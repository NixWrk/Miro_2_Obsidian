from __future__ import annotations

import argparse
import socket
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlunsplit


CURRENT_ENTRYPOINT = "/index.html"
LEGACY_PATHS = {
    "/index-20260611-deep-table.html": "/index.html",
    "/index-20260727-complete-json.html": "/index.html",
    "/panel-20260611-deep-table.html": "/panel.html",
    "/panel-20260727-complete-json.html": "/panel.html",
}


def resolve_request_path(path: str) -> str:
    """Serve the SDK bootstrap from Miro's selected authorization callback URI."""
    parsed = urlsplit(path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path.rstrip("/") == "/callback" and "code" not in query:
        return urlunsplit(("", "", CURRENT_ENTRYPOINT, parsed.query, ""))
    if parsed.path in LEGACY_PATHS:
        return urlunsplit(("", "", LEGACY_PATHS[parsed.path], parsed.query, ""))
    return path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.path = resolve_request_path(self.path)
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        self.path = resolve_request_path(self.path)
        super().do_HEAD()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


def server_specs(host: str) -> list[tuple[str, type[ThreadingHTTPServer]]]:
    if host.lower() == "localhost":
        return [
            ("127.0.0.1", ThreadingHTTPServer),
            ("::1", IPv6ThreadingHTTPServer),
        ]
    server_type = IPv6ThreadingHTTPServer if ":" in host else ThreadingHTTPServer
    return [(host, server_type)]


def websdk_directory() -> Path:
    """Find the same static app in a checkout, wheel, or frozen executable."""
    candidates = []
    if getattr(sys, "_MEIPASS", None):
        candidates.append(Path(sys._MEIPASS) / "share" / "miro2obsidian" / "websdk")
    candidates.extend([
        Path(__file__).resolve().parents[1] / "tools" / "miro_websdk_exporter",
        Path(sys.prefix) / "share" / "miro2obsidian" / "websdk",
    ])
    for directory in candidates:
        if all((directory / name).is_file() for name in ("index.html", "panel.html", "exporter.js")):
            return directory
    raise FileNotFoundError("The Web SDK exporter is missing from this installation.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the Miro Web SDK exporter without browser caching.")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args(argv)

    directory = args.directory or websdk_directory()
    handler = partial(NoCacheHandler, directory=str(directory))
    specs = server_specs(args.host)
    servers = [specs[0][1]((specs[0][0], args.port), handler)]
    for host, server_type in specs[1:]:
        try:
            servers.append(server_type((host, args.port), handler))
        except OSError:
            # IPv6 is optional on some machines; IPv4 localhost remains usable.
            pass
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True)
        for server in servers[1:]
    ]
    for thread in threads:
        thread.start()
    print(
        f"serving_no_cache=http://{args.host}:{args.port}{CURRENT_ENTRYPOINT}",
        flush=True,
    )
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
