"""Compatibility launcher for the packaged Web SDK server."""

from miro2obsidian.websdk_server import (  # noqa: F401
    CURRENT_ENTRYPOINT,
    LEGACY_PATHS,
    IPv6ThreadingHTTPServer,
    NoCacheHandler,
    main,
    resolve_request_path,
    server_specs,
)


if __name__ == "__main__":
    raise SystemExit(main())
