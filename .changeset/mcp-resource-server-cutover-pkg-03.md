---
"@cg3/equip": minor
---

feat(auth): uniform augment-def shape + OAuthDcrProvider stub (Pkg 03)

mcp-resource-server-cutover Wave 1 / Pkg 03. Equip-side schema +
provider rewrite. Behavior-preserving: legacy registry rows still
work; new uniform shape adds audience + scopes + dcr fields.

- AuthConfig adds `audience?`, `scopes?`, `dcr?`, plus `"oauth-dcr"` to
  the type discriminated union.
- StoredCredential adds `audience?` + `scopes?` so refresh re-mints
  with consistent claims without re-reading auth-config.
- OidcProvider passes auth.audience + auth.scopes to /token; falls
  back to legacy values (audience=augmentName, scope=identity:read)
  when overrides are absent — W1 compat for unmigrated registry rows.
- New OAuthDcrProvider schema-only stub (acquire/refresh return
  ok:false code "not_implemented" until first publisher integration).
