"""Shared first-time setup guidance, without account-specific links or secrets."""

import html

MIRO_APPS_URL = "https://developers.miro.com/page/developer-hub#your-apps"
APP_NAME = "Miro Full Exporter"
APP_URL = "http://localhost:8766/index.html"
REDIRECT_URI = "http://localhost:8765/callback"
SCOPES = "boards:read team:read"
CREATE_HELP = "Open Developer Hub, sign in and choose Your apps, then Create new app or Create your first app. If Profile settings opens instead, use Get started in the Explore the Developer Hub banner. Apps & Integrations lists installed apps; it does not create your own app."
TEAM_HELP = "Name the app Miro Full Exporter and select a Developer team. If Miro asks for an Enterprise Developer team, your organization administrator must set it up; a team merely named Dev team is not enough."
TOKEN_HELP = "Before Create app, leave Expire user authorization token unchecked. This version does not renew expiring tokens. Miro makes this choice permanent for the app; an expiring app needs reconnection after expiry or a new app with the correct setting."
ACCESS_HELP = "An access token is the permission to export your board. This program obtains it automatically through Miro authorization; you do not paste it here. Client ID identifies the app, and Client secret is the app's separate key."
CONFIG_HELP = "In the app settings, paste these two addresses and save them. Enable Use this URI for SDK authorization if offered. Select only boards:read and team:read. Install the app in the team that owns your board."
CONNECT_HELP = "Copy Client ID and Client secret from App Credentials into the fields below. Keep Miro and authorization in the same browser. These values stay in local memory; Code automation saves only the access token in the OS credential store."


def _copy_value(identifier: str, label: str, value: str) -> str:
    return (
        f'<div class="copy-row"><label for="{identifier}">{html.escape(label)}</label>'
        f'<input id="{identifier}" value="{html.escape(value, quote=True)}" readonly>'
        f'<button type="button" data-copy-target="{identifier}">Copy</button></div>'
    )


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
        + _copy_value("setup-scopes", "Permissions (scopes)", SCOPES)
        + '<button type="button" data-step-target="0">Back</button> '
        '<button type="button" data-step-target="2">App configured — continue</button></section>'
        '<p id="copy-status" role="status" aria-live="polite" data-ui-message=""></p>'
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
