---
"@cg3/equip": patch
---

Fix TOML serialization of Windows paths. `buildTomlEntry` was emitting paths with backslashes inside basic strings (`command = "c:\dev\..."`) which is invalid TOML — `\d`, `\C` etc. are reserved escape sequences. Codex's TOML parser rejected these entries, breaking augment install. Switch to TOML literal strings (single-quoted) when a value contains a backslash, fall back to escaped basic strings otherwise. Also extend `parseTomlServerEntry` to recognize literal strings so the round-trip used by `repairBrokerShimPaths` doesn't see drift on its own writes.
