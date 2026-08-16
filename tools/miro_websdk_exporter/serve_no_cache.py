from __future__ import annotations

import argparse
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlunsplit


CURRENT_ENTRYPOINT = "/index-20260727-complete-json.html"


def resolve_request_path(path: str) -> str:
    """Serve the SDK bootstrap from Miro's selected authorization callback URI."""
    parsed = urlsplit(path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path.rstrip("/") == "/callback" and "code" not in query:
        return urlunsplit(("", "", CURRENT_ENTRYPOINT, parsed.query, ""))
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


def server_specs(host: str) -> list[tuple[str, type[ThreadingHTTPServer]]]:
    if host.lower() == "localhost":
        return [
            ("127.0.0.1", ThreadingHTTPServer),
            ("::1", IPv6ThreadingHTTPServer),
        ]
    server_type = IPv6ThreadingHTTPServer if ":" in host else ThreadingHTTPServer
    return [(host, server_type)]


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the Miro Web SDK exporter without browser caching.")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()

    handler = partial(NoCacheHandler, directory=str(args.directory))
    servers = [
        server_type((host, args.port), handler)
        for host, server_type in server_specs(args.host)
    ]
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
