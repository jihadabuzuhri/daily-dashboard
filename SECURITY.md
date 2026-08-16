# Security Policy

## Scope

Daily Dashboard is a static single-page app with no backend, no accounts, and no server-side
component. Your data lives in your own browser (`localStorage`), in a local file while developing
(`data/store.json`), and — only if you opt in — in a private GitHub gist that you own.

The one piece of sensitive material the app handles is the **GitHub personal access token** used
for optional gist sync. It is stored in `localStorage` under `daily-dashboard:gist` on the device
where you entered it, and is sent only to `api.github.com` over TLS.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/jihadabuzuhri/daily-dashboard/security/advisories/new)
form. Include:

- A description of the issue and why you think it's exploitable.
- Steps to reproduce, or a proof of concept.
- The affected version or commit, and the browser you observed it in.

You should get an initial response within a week. If the report is confirmed, the fix will be made
in the open once it's ready, and you'll be credited unless you'd rather not be.

**Never include your personal access token, gist ID, or the contents of a private gist in a
report** — redact them from any logs or screenshots first.

## Token hygiene

If you use gist sync, the recommended setup limits the blast radius of a leaked token:

- Use a **fine-grained** PAT with **Repository access: None** and **Account permissions → Gists:
  Read and write**. A leaked token then reaches your gists and nothing else.
- Set an expiration. The app raises a toast on a `401` so you know to rotate.
- Click **Disable** in the sync dialog, or clear browser site data, to remove the token from a
  device.
- Revoke a compromised token immediately at
  <https://github.com/settings/tokens?type=beta>.

## Supported versions

This project has a single active line of development. Fixes land on `main` and reach the deployed
site on the next build; there are no maintained release branches.
