from __future__ import annotations

import os
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"

from scripts.miro_oauth_token import (  # noqa: E402
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
    authorize_and_get_token as _authorize_and_get_token,
    config_from_env,
)


CLIENT_ID = os.environ.get("MIRO_CLIENT_ID", "")
CLIENT_SECRET = ""
REDIRECT_URI = os.environ.get("MIRO_REDIRECT_URI", DEFAULT_REDIRECT_URI)
SCOPES = os.environ.get("MIRO_SCOPES", DEFAULT_SCOPES)


def authorize_and_get_token() -> str:
    """Use the shared, hardened loopback OAuth implementation."""
    return _authorize_and_get_token(config_from_env())
