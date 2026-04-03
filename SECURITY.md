# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | No       |

We recommend always running the latest version of equip.

## Reporting a Vulnerability

If you discover a security vulnerability in equip, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@cg3.io** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Any suggested fix (optional)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The following are in scope:

- Credential storage and handling (`~/.equip/credentials/`)
- OAuth flow implementation (PKCE, token exchange)
- Platform config file manipulation (injection, corruption)
- Telemetry data collection (unintended PII leaks)
- Supply chain concerns (dependency integrity)

## Security Design

- **Zero runtime dependencies** — minimizes supply chain attack surface
- **Atomic file writes** — prevents partial-write credential exposure
- **Restrictive file permissions** — credentials stored with `0600` on Unix
- **OAuth PKCE** — no client secrets stored; authorization code flow with code challenge
- **Path sanitization** — home directory paths stripped from telemetry
- **HTML escaping** — OAuth callback pages escape all dynamic content
