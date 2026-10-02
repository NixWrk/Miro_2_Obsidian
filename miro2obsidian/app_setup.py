"""Help for creating the user's own Miro app (the one step code cannot do).

Miro's security model requires every person to own the app that reads their
boards. Creating it happens in Miro's Developer Hub, in a browser. This module
only provides the *text* for that step: a manifest to paste and a structured
checklist that the CLI (``setup guide``), the GUI and agents render. Nothing
here contacts Miro or handles a secret.

Miro changes screen labels from time to time, so every instruction says that
the wording on screen may differ and names the *purpose* of each field.
"""

from __future__ import annotations

import json
import re
from typing import Any

__all__ = [
    "DEFAULT_APP_NAME",
    "DEVELOPER_HUB_URL",
    "app_manifest_yaml",
    "setup_steps",
]

DEVELOPER_HUB_URL = "https://developers.miro.com/page/developer-hub#your-apps"
DEFAULT_APP_NAME = "Miro to Obsidian - local export"
DEFAULT_SDK_PORT = 8766
DEFAULT_OAUTH_PORT = 8765
SCOPES = ("boards:read", "team:read")

_PLAIN_YAML = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.\-]*")


def _port(value: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError(f"{label} must be a port number between 1 and 65535")
    return value


def _yaml_scalar(text: str) -> str:
    if "\n" in text or "\r" in text:
        raise ValueError("app_name must be a single line")
    text = text.strip()
    if not text:
        raise ValueError("app_name must not be empty")
    if _PLAIN_YAML.fullmatch(text):
        return text
    # A JSON string is a valid YAML double-quoted scalar.
    return json.dumps(text, ensure_ascii=False)


def app_manifest_yaml(
    *,
    app_name: str = DEFAULT_APP_NAME,
    sdk_port: int = DEFAULT_SDK_PORT,
    oauth_port: int = DEFAULT_OAUTH_PORT,
) -> str:
    """Return a Miro app manifest (YAML) for the local export app.

    It carries only the keys Miro's manifest editor accepts: ``appName``,
    ``sdkUri``, ``redirectUris`` and ``scopes``. The repository's
    ``manifest.example.yml`` also lists icon files; those must be hosted, so
    they are left out here (the app works without an icon, it just shows a
    default one).
    """
    sdk_port = _port(sdk_port, "sdk_port")
    oauth_port = _port(oauth_port, "oauth_port")
    lines = [
        "# Miro app manifest for Miro to Obsidian (local export).",
        "# Paste it into the app settings if your Miro app page offers editing the",
        "# app manifest; otherwise enter the same values by hand.",
        f"appName: {_yaml_scalar(app_name)}",
        f"sdkUri: http://localhost:{sdk_port}/index.html",
        "redirectUris:",
        f"  - http://localhost:{oauth_port}/callback",
        "# Also select 'Use this URI for SDK authorization' on the redirect URI.",
        "scopes:",
        *(f"  - {scope}" for scope in SCOPES),
        "",
    ]
    return "\n".join(lines)


def setup_steps(
    *,
    app_name: str = DEFAULT_APP_NAME,
    sdk_port: int = DEFAULT_SDK_PORT,
    oauth_port: int = DEFAULT_OAUTH_PORT,
) -> list[dict[str, Any]]:
    """The one-time Miro app checklist as structured data.

    Each step has ``id``, ``title``, ``instructions`` (plain language),
    ``url`` (or ``None``), ``copy_values`` (label -> exact text to copy) and
    ``actor``: ``"person"`` for a step only a human can do, ``"program"`` for a
    step a command performs. Steps are in the order to follow them.
    """
    sdk_port = _port(sdk_port, "sdk_port")
    oauth_port = _port(oauth_port, "oauth_port")
    app_url = f"http://localhost:{sdk_port}/index.html"
    redirect_uri = f"http://localhost:{oauth_port}/callback"
    manifest = app_manifest_yaml(app_name=app_name, sdk_port=sdk_port, oauth_port=oauth_port)
    labels_note = (
        "Miro renames screens now and then, so the labels on your screen may "
        "differ slightly from the ones quoted here; look for the same purpose."
    )
    return [
        {
            "id": "open_developer_hub",
            "title": "Open the Miro Developer Hub",
            "instructions": (
                "Sign in to Miro in your browser, then open the Developer Hub "
                "page 'Your apps'. (In Miro you can also open your avatar and "
                "choose Developer Hub, then Your apps.) " + labels_note
            ),
            "url": DEVELOPER_HUB_URL,
            "copy_values": {},
            "actor": "person",
        },
        {
            "id": "create_app",
            "title": "Create your own Miro app in a Developer team",
            "instructions": (
                "Pick the organization and a Developer team (create one and "
                "accept the developer terms if none exists), then create a new "
                "app. Give it a recognizable name. Creating the app does not "
                "move or copy any board; it only creates the credentials and "
                "permissions this program uses. Miro requires every person to "
                "own this app, so it cannot be done for you."
            ),
            "url": DEVELOPER_HUB_URL,
            "copy_values": {"App name": app_name},
            "actor": "person",
        },
        {
            "id": "configure_app",
            "title": "Set the app URL, redirect URI and permissions",
            "instructions": (
                "Option A: if your app settings page offers editing the app "
                "manifest, paste the manifest below and save. "
                "Option B: set the fields by hand. Set the App URL (also called "
                f"SDK URI) to {app_url}. Add the redirect URI {redirect_uri} "
                "and, in that URI's options, select 'Use this URI for SDK "
                "authorization'. Select the permissions (scopes) boards:read "
                "and team:read, and nothing else. Save. "
                "You may switch on 'Expire user authorization token': Miro to "
                "Obsidian supports it either way and renews such tokens by "
                "itself. Use the host name localhost exactly as written, not "
                "127.0.0.1. " + labels_note
            ),
            "url": None,
            "copy_values": {
                "App manifest (YAML)": manifest,
                "App URL": app_url,
                "Redirect URI": redirect_uri,
                "Scopes": " ".join(SCOPES),
            },
            "actor": "person",
        },
        {
            "id": "install_app",
            "title": "Install the app into the team that owns your boards",
            "instructions": (
                "In the app settings choose 'Install app and get OAuth token' "
                "(or the equivalent button), select the team that owns the "
                "boards you want to export, review the permissions and confirm. "
                "An app installed only in your Developer team will not see "
                "boards of another team, so install it in the board owner's "
                "team. If the team is missing or installing apps is restricted, "
                "ask that team's administrator to approve the app. You do not "
                "need to copy the access token Miro may show you here."
            ),
            "url": None,
            "copy_values": {},
            "actor": "person",
        },
        {
            "id": "connect",
            "title": "Connect the program to your app",
            "instructions": (
                "Run the command below. It opens a local form in your browser: "
                "paste the app's Client ID and Client secret (from the app "
                "settings, under its credentials) into that form only, never "
                "into a chat or file, then approve access in Miro. The "
                "connection is saved in your operating system credential store "
                "and renews itself afterwards."
            ),
            "url": None,
            "copy_values": {"Command": "miro2obsidian auth login --form"},
            "actor": "program",
        },
        {
            "id": "open_app_on_board",
            "title": "First export only: start the app on the board if Miro does not",
            "instructions": (
                "When an export opens a board, the Miro to Obsidian app should "
                "start by itself and send the board data to the program. If "
                "nothing happens within about 20 seconds, click the app's icon "
                "in the board's left toolbar (or More apps, then the app). If "
                "the icon is missing, the app is not installed in this board's "
                "team: repeat the install step for that team."
            ),
            "url": None,
            "copy_values": {},
            "actor": "person",
        },
    ]
