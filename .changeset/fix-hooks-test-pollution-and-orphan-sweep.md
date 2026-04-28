---
"@cg3/equip": patch
---

fix(equip): hooks test pollution + doctor orphan-hook sweep

Two related hook-handling fixes:

- **Test pollution.** `installHooks`/`uninstallHooks`/`hasHooks` now accept an
  optional `settingsPath` override. Tests no longer write to the user's real
  `~/.claude/settings.json` (which leaked entries on aborted runs — visible as
  stale `node "<tempdir>/test-hook.js"` entries surviving in user settings).

- **Orphan hook sweep.** `equip doctor` now scans each platform's settings file
  for hook entries whose script files no longer exist on disk and warns about
  them. Run `equip doctor --fix-orphan-hooks` to prune. Catches stale entries
  left behind when an augment that previously shipped hooks is uninstalled or
  transitions to `hooks: null` without the consumer-side settings being
  reconciled.

Public-API additions: `findOrphanHookEntries`, `OrphanHookEntry`. The
`settingsPath` option is additive — existing callers are unaffected.
