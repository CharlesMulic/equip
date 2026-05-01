---
"@cg3/equip": patch
---

fix(equip): hooks test pollution + doctor orphan-hook sweep

Two related hook-handling fixes:

- **Test isolation.** `installHooks`/`uninstallHooks`/`hasHooks` now accept an
  optional `settingsPath` override so tests can run against temporary platform
  settings instead of a contributor's real `~/.claude/settings.json`.

- **Orphan hook sweep.** `equip doctor` now scans each platform's settings file
  for hook entries whose script files no longer exist on disk and warns about
  them. Run `equip doctor --fix-orphan-hooks` to prune stale entries left behind
  when a hook script has been removed outside the platform settings file.

Public-API additions: `findOrphanHookEntries`, `OrphanHookEntry`. The
`settingsPath` option is additive — existing callers are unaffected.
