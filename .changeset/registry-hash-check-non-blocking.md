---
"@cg3/equip": patch
---

Demote registry content-hash mismatch from throw to warning. Registry and client hash versions can disagree, and treating every mismatch as fatal can strand users on stale local cache even when the live definition is otherwise usable. Equip now trusts HTTPS/CDN transport integrity, warns on the mismatch, and continues until registry hash negotiation is reconciled.
