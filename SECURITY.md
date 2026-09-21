# Security Policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability.

Instead, report it privately using GitHub's built-in reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue: what it is, how to reproduce it, and its impact.

This opens a private conversation with the maintainers so the issue can be assessed and
fixed before details are public.

## Scope

This policy covers the launcher in this repository: the Electron app, its Microsoft
sign-in flow, its handling of session tokens and pack files, and its build/update
tooling.

The Aetherspire game server and its API are a separate, non-public project and are out of
scope for this repository, but issues there (for example, a problem with how the API
responds to the launcher) can be reported the same way, through this repository's Security
tab, and will be passed along.

## What to expect

Reports are reviewed as time allows by a small team. There is no guaranteed response time,
but valid reports affecting the launcher will be prioritized over regular feature work.
