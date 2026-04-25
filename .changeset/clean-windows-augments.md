---
"@cg3/equip": patch
---

Handle unreadable local augment definition files without crashing Equip loadout reads, repair Windows Equip JSON state files affected by a bad inherited-ACL write path, let registry installs upgrade auto-wrapped augment definitions that were detected before registry metadata was cached, and scope registry definition cache fallback by registry URL so staging/prod/local cache entries cannot bleed into each other.
