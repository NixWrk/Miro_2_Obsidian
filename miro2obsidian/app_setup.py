"""Shared first-time setup guidance, without account-specific links or secrets."""

MIRO_APPS_URL = "https://miro.com/app/settings/user-profile/apps/"


def setup_intro_html(*, refresh_supported: bool = False) -> str:
    """Explain app creation before showing the separate credentials form."""
    expiry = (
        "Expiring authorization tokens are supported; the saved connection can renew them."
        if refresh_supported else
        "Leave Expire user authorization token unchecked for unattended Code mode; "
        "this version does not renew expiring tokens."
    )
    return (
        '<section aria-labelledby="create-app"><h2 id="create-app">No Miro app yet?</h2>'
        '<p>Start here before entering Client ID or Client secret.</p><ol>'
        f'<li><a href="{MIRO_APPS_URL}" target="_blank" rel="noopener noreferrer">'
        'Open Miro Settings &rarr; Your apps</a><br>Sign in in this browser. '
        'Miro may redirect to a company-specific settings address. If the link does not '
        'open Your apps, use your Miro avatar &rarr; Settings &rarr; Your apps.</li>'
        '<li>In Your apps click <strong>Create new app</strong>, name it '
        '<strong>Miro Full Exporter</strong> and select a Developer team. '
        'Create a Developer team if Miro asks. The Explore the Developer Hub / '
        'Get started banner is optional; use Create new app below it.</li>'
        '<li>Set App URL / SDK URI to <code>http://localhost:8766/index.html</code> '
        'and OAuth redirect URI to <code>http://localhost:8765/callback</code>. '
        'Select Use this URI for SDK authorization if offered. Choose only '
        '<code>boards:read</code> and <code>team:read</code>, then save. '
        + expiry + '</li>'
        '<li>Install and authorize the app in the team that owns your board. '
        'If installation is restricted, ask its administrator.</li>'
        '</ol><p>Keep this page and Miro in the same browser. If an email sign-in link '
        'opens another browser, finish setup in that browser too: login sessions do '
        'not transfer between browsers.</p></section>'
    )
