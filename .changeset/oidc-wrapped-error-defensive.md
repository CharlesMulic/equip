---
"@cg3/equip": patch
---

Fix `OidcProvider.tokenExchange` throwing `TypeError: undefined is not a function` when the AS returns the wrapped `{ok: false, error: {code, message}}` envelope instead of the RFC-6749 flat `{error, error_description}` shape. Coerce the description to a string defensively before calling `.includes(...)`.
