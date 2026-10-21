"""Help for configuring a Miro app for this local-first program.

This program uses an app the user configures in Miro's Your apps settings. This module
only provides the *text* for that step: a manifest to paste and a structured
checklist that the CLI (``setup guide``), the GUI and agents render. Nothing
here contacts Miro or handles a secret.

Miro changes screen labels from time to time, so every instruction says that
the wording on screen may differ and names the *purpose* of each field.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any

__all__ = [
    "DEFAULT_APP_NAME",
    "DEVELOPER_HUB_URL",
    "app_manifest_yaml",
    "setup_steps",
]

MIRO_APPS_URL = "https://developers.miro.com/page/developer-hub#your-apps"
# Keep the public name used by CLI, GUI and MCP adapters.
DEVELOPER_HUB_URL = MIRO_APPS_URL
DEFAULT_APP_NAME = "Miro Full Exporter"
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
            "title": "Open Miro Settings > Your apps",
            "instructions": (
                "Open this link in your normal browser and sign in to Miro. "
                "Miro may redirect to a company-specific Profile settings URL; "
                "choose the Your apps tab. If the link does not open it, use "
                "your Miro avatar, Settings, then Your apps. The Explore the "
                "Developer Hub / Get started banner is optional. Finish email "
                "sign-in and setup in the same browser: sessions do not transfer "
                "between browsers. " + labels_note
            ),
            "url": DEVELOPER_HUB_URL,
            "copy_values": {},
            "actor": "person",
        },
        {
            "id": "create_app",
            "title": "Create your own Miro app in a Developer team",
            "instructions": (
                "In Your apps click Create new app below the Developer Hub banner. "
                "Pick the organization and a Developer team (create one and "
                "accept the developer terms if none exists), then create a new "
                "app. Give it a recognizable name. Creating the app does not "
                "move or copy any board; it only creates the credentials and "
                "permissions this program uses. This local-first program uses "
                "an app you configure rather than shipping shared credentials."
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


def setup_intro_html(*, refresh_supported: bool = False) -> str:
    """The two public setup steps; browser_setup adds credentials as step three."""
    token_help = (
        "Expiring authorization tokens are supported; the saved connection can renew them."
        if refresh_supported else TOKEN_HELP
    )
    return (
        '<nav class="setup-nav" aria-label="Connection steps">'
        '<button type="button" data-step-target="0">1. Create app</button>'
        '<button type="button" data-step-target="1">2. Configure app</button>'
        '<button type="button" data-step-target="2">3. Connect</button></nav>'
        '<section data-setup-panel="0"><h2>Create your Miro app</h2>'
        f'<p>{CREATE_HELP}</p>'
        f'<a href="{MIRO_APPS_URL}" target="_blank" rel="noopener noreferrer">Open Developer Hub</a>'
        + _copy_value("setup-hub", "Developer Hub address", MIRO_APPS_URL)
        + _copy_value("setup-name", "App name", APP_NAME)
        + f'<p>{TEAM_HELP}</p><h3>Authorization token</h3><p>{token_help}</p>'
        '<button type="button" data-step-target="1">App created — continue</button> '
        '<button type="button" data-step-target="2">I already have a configured app</button></section>'
        '<section data-setup-panel="1" hidden><h2>Configure your Miro app</h2>'
        f'<p>{CONFIG_HELP}</p>'
        + _copy_value("setup-app-url", "App URL / SDK URI", APP_URL)
        + _copy_value("setup-redirect", "Redirect URI for OAuth 2.0", REDIRECT_URI)
        + _copy_value("setup-scopes", "Permissions (scopes)", " ".join(SCOPES))
        + '<button type="button" data-step-target="0">Back</button> '
        '<button type="button" data-step-target="2">App configured — continue</button></section>'
        '<p id="copy-status" role="status" aria-live="polite" data-ui-message=""></p>'
    )


# Shared copy and presentation for the desktop and browser setup.
APP_NAME = "Miro Full Exporter"

APP_URL = "http://localhost:8766/index.html"

REDIRECT_URI = "http://localhost:8765/callback"

CREATE_HELP = "Open Developer Hub, sign in and choose Your apps, then Create new app or Create your first app. If Profile settings opens instead, use Get started in the Explore the Developer Hub banner. Apps & Integrations lists installed apps; it does not create your own app."

TEAM_HELP = "Name the app Miro Full Exporter and select a Developer team. If Miro asks for an Enterprise Developer team, your organization administrator must set it up; a team merely named Dev team is not enough."

TOKEN_HELP = "Choose the token lifetime before creating the app. Expiring tokens are supported: the saved connection renews them automatically when Miro provides a refresh token. Sign-in or consent can still be required after access is revoked."

ACCESS_HELP = "An access token is the permission to export your board. This program obtains it automatically through Miro authorization; you do not paste it here. Client ID identifies the app, and Client secret is the app's separate key."

CONFIG_HELP = "In the app settings, paste these two addresses and save them. Enable Use this URI for SDK authorization if offered. Select only boards:read and team:read. Install the app in the team that owns your board."

CONNECT_HELP = "Copy Client ID and Client secret from App Credentials into the fields below. Finish authorization in the same browser. The connection, including the app secret and refresh token, is kept in your operating system credential store so future exports can renew access automatically. Nothing is written to project files."

def _copy_value(identifier: str, label: str, value: str) -> str:
    return (
        f'<div class="copy-row"><label for="{identifier}">{html.escape(label)}</label>'
        f'<input id="{identifier}" value="{html.escape(value, quote=True)}" readonly>'
        f'<button type="button" data-copy-target="{identifier}">Copy</button></div>'
    )

SETUP_SCRIPT = """
document.addEventListener('DOMContentLoaded', () => {
  const panels = [...document.querySelectorAll('[data-setup-panel]')];
  if (!panels.length) return;
  const show = step => {
    panels.forEach(panel => { panel.hidden = panel.dataset.setupPanel !== step; });
    document.querySelectorAll('.setup-nav [data-step-target]').forEach(button => {
      button.setAttribute('aria-current', button.dataset.stepTarget === step ? 'step' : 'false');
    });
  };
  document.querySelectorAll('[data-step-target]').forEach(button =>
    button.addEventListener('click', () => show(button.dataset.stepTarget)));
  document.querySelectorAll('[data-copy-target]').forEach(button => button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById('copy-status');
    if (!input?.readOnly) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
      else {
        input.focus(); input.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
      }
      window.miro2obsidianUI.setMessage(status, 'Copied.');
    } catch (_) {
      input.focus(); input.select();
      window.miro2obsidianUI.setMessage(status, 'Copy failed. Select the address and press Ctrl+C.');
    }
  }));
  show('0');
});
"""
