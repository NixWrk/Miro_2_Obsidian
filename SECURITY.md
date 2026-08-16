# Security Policy

## Supported code

Security fixes target the current `main` branch. No stable release line has been
published yet.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, private board data, or OAuth
callback codes in a public issue.

Use GitHub's private vulnerability reporting feature when it is enabled for the
repository. Otherwise, contact the repository owner privately through the
owner's GitHub profile and include only enough information to establish a safe
reporting channel.

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

The current working tree intentionally contains only
`.miro_oauth.local.example.json` with placeholders. This does not certify the
Git history: a previously committed Miro credential must be revoked and removed
from reachable history before the repository is made public.

## Local services

The OAuth callback server and Web SDK exporter bind to loopback interfaces for
local workflows. Keep the OAuth callback on port `8765` and the Web SDK static
server on `8766`; do not expose either service to an untrusted network.
