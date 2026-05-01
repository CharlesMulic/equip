---
"@cg3/equip": minor
---

feat(auth): uniform auth metadata + OAuthDcrProvider stub

Equip now accepts uniform auth metadata for augments. The provider rewrite is
behavior-preserving for existing registry rows; the new shape adds audience,
scopes, and DCR metadata for future delegated-auth flows.

- AuthConfig adds `audience?`, `scopes?`, `dcr?`, plus `"oauth-dcr"` to
  the type discriminated union.
- StoredCredential adds `audience?` + `scopes?` so refresh re-mints
  with consistent claims without re-reading auth-config.
- OidcProvider passes auth.audience + auth.scopes to /token; falls
  back to legacy values (audience=augmentName, scope=identity:read)
  when overrides are absent.
- New OAuthDcrProvider schema-only stub (acquire/refresh return
  ok:false code "not_implemented" until runtime support ships).
