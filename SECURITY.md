# Security Policy

## Supported code

Security fixes target the current `main` branch. No stable release line has been
published yet.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, private board data, or OAuth
callback codes in a public issue.

Use the repository's
[private security advisory form](https://github.com/NixWrk/Miro_2_Obsidian/security/advisories/new).
If that form is unavailable, contact the repository owner through the GitHub
profile and include only enough information to establish a private reporting
channel. Never put a credential or private board sample in a public issue.

Please include:

- the affected command, module, or workflow;
- reproduction steps using synthetic data;
- the impact and any known prerequisites;
- whether credentials or private exports may have been exposed.

## Credential handling

- Use `MIRO_CLIENT_ID`, `MIRO_CLIENT_SECRET`, and `MIRO_ACCESS_TOKEN` only in the
  local environment or ignored local configuration.
- Never commit `.miro_oauth.local.json`, `.env`, access tokens, client secrets,
  authorization codes, or callback URLs containing `code=...`.
- Treat real Miro exports and downloaded assets as private unless they have been
  deliberately minimized and cleared for publication.
- Revoke and rotate a credential immediately if it enters Git history. Deleting
  it from the latest commit is not sufficient.

The release tree intentionally contains only `.miro_oauth.local.example.json`
with placeholders. The publication process removes the known historical
credential from reachable branches and tags. Rotation is still mandatory:
existing clones, forks, caches, and pull-request references may retain old
objects even after a history rewrite.

After a history rewrite, discard old clones or re-clone them. Do not merge an
old branch back into the cleaned history.

## What is stored on your computer

`miro2obsidian auth login` (and the GUI's **Set up Miro app**) saves one
connection record in the current OS user's credential store: Windows Credential
Manager, macOS Keychain, or a Linux Secret Service keyring. The record holds:

- the **Client ID** and **Client secret** of your own Miro app;
- the access token and refresh token, and when the access token expires;
- the team and the granted scopes.

It is never written to a project file, a log, a command-line argument, or the
output of any command. `auth status`, `doctor` and the MCP tools report only
whether a connection exists, its team, scopes and expiry.

**The trade-off.** Earlier versions kept only an access token. The client secret
is now stored as well, because renewing an expiring token and recovering without
a person (a scheduled run) both need it. Anyone who can read this credential
store as the same OS user can act as your Miro app. If the computer is shared or
may be compromised, rotate the client secret in Miro.

Windows Credential Manager limits a record to 2560 bytes, so a larger record is
split into numbered parts plus a checksummed manifest. This has not been checked
on a real Windows machine yet.

**Remove it.**

- `miro2obsidian auth logout` (or the GUI's disconnect button) asks Miro to
  revoke the token on a best-effort basis and always deletes the saved record
  locally. `--no-revoke` skips the revoke request.
- To revoke the grant in Miro yourself, open the Developer Hub, **Your apps**, and
  uninstall the app from the team (or delete the app). To invalidate the client
  secret, regenerate it in the app's settings.
- With no OS credential store, set `MIRO_ACCESS_TOKEN` for a single run instead.
  It takes precedence over the saved connection and does not renew itself.

## Web SDK hand-off

The Miro app (the exporter) sends the whole-board capture to the local program
instead of making you download and pick a file. The server that receives it
(`miro2obsidian websdk-serve`, or started automatically by `import` and
`capture`) applies these checks:

- loopback only, and every `/api/` request needs a loopback `Host` header with
  the server's own port (defeats DNS rebinding);
- same-origin only: no CORS headers are ever sent and `OPTIONS` is refused, so a
  web page from another origin cannot read the token; uploads must carry a
  same-origin `Origin`, and cross-site `Sec-Fetch-Site` values are refused;
- a random per-process token, compared in constant time, is required for every
  write;
- uploads must be JSON, are size-limited (512 MiB by default), streamed to a
  temporary file, strictly validated (board identity, profile, freshness) and
  renamed into place atomically; nothing is stored on failure and payload
  contents are never logged or echoed.

Captures are stored in a per-user folder (`MIRO2OBSIDIAN_CAPTURE_DIR` overrides
it). They contain your board content, so treat them like any private export and
delete old ones. The token protects against web pages, not against other
programs running as the same OS user.

The exact rules are in the
[exporter README](tools/miro_websdk_exporter/README.md#security-model).

## Agents

An AI agent that runs the commands or the MCP tools gets a deliberately narrow
view.

- **Agents never see secrets.** No command or tool accepts a secret as an
  argument, and none prints one. The person types the Client ID and Client secret
  into the local form (`auth login --form`), which runs on their own computer.
  An agent that asks for a secret, or for a token, is misbehaving.
- **Board text is untrusted.** Board content, titles and command output can
  carry instructions written by someone else ("prompt injection"). Agents must
  treat them as data, never as instructions. The agent guide, the skill and the
  GUI's agent prompt all say so. The program cannot enforce this inside a
  model, so prefer an agent you trust with your vault, and read what it reports.
- **Relay, do not decide.** When a result is `needs_user`, the agent shows
  `message` and `next_step` verbatim. It does not bypass sign-in, MFA, consent
  or administrator approval.
- **Narrow write scope.** The agent is told to run `import` and not to edit or
  delete vault files. The GUI accepts an agent result only if the artifact is
  inside the chosen folder and passes the Canvas and file checks.
- **Bounded runs.** In the GUI's Agent mode a timeout stops the agent and all of
  its child processes. Its stderr goes to a log file in the app data `logs`
  folder (the last 20 are kept). Those logs hold only what the agent printed;
  check them before sharing.

### The browser profile in Agent mode

Agent mode opens a dedicated Chromium profile (`browser-profile` in the app data
directory: `%LOCALAPPDATA%\miro2obsidian` on Windows, `~/Library/Application
Support/miro2obsidian` on macOS, `$XDG_DATA_HOME/miro2obsidian` or
`~/.local/share/miro2obsidian` elsewhere). It keeps your Miro sign-in so later
runs do not ask again. While an agent runs, a random loopback Chrome DevTools
Protocol (CDP) port is open. Anything on this computer that can reach that port
can drive the browser, including the signed-in Miro session, so run Agent mode
only on a machine you control. The port closes when the run ends.

Never point `MIRO2OBSIDIAN_BROWSER_PROFILE` at your everyday browser profile.
To remove the sign-in, close the app and delete the `browser-profile` folder, and
sign out of Miro there if you wish. Deleting the profile does not affect the
saved connection above.

## Local services

The OAuth callback server, the connection form (`auth login --form`,
`setup-serve`) and the Web SDK exporter server bind to loopback interfaces for
local workflows. Keep the OAuth callback on port `8765` and the Web SDK server
on `8766`; do not expose either service to an untrusted network. If a port is
busy, `miro2obsidian doctor` reports it.
