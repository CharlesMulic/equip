---
"@cg3/equip": patch
---

Demote registry content-hash mismatch from throw to warning. The v1/v2 hash protocol gap between backend and client (ENG-0071) was silently failing every API fetch and falling back to stale local cache. This broke the mcp-resource-server-cutover because the cached prior.json pinned the legacy `oauth_to_api_key` + `prior-cli` auth shape after the registry had already cut over to the uniform `oidc` shape. Trust HTTPS+CDN for transport integrity until the protocol gap is reconciled.
