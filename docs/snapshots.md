# Platform Config Snapshots

Equip snapshots are restore points for platform-owned config files. They are the safety net behind the promise that you can try Equip without losing the config state you had before Equip touched anything.

Snapshots are owned by the `@cg3/equip` CLI/library. Desktop and web surfaces may render snapshot state, but the CLI/library owns capture, restore, diff, pruning, and restore semantics.

## What Gets Captured

Each snapshot records:

- Platform ID, label, trigger, timestamp, and Equip version.
- The platform config path and raw file content, when the file exists.
- The platform rules path and raw file content, when the path is a regular file.

Snapshots do not capture directories. If a platform's rules path is a directory, Equip records the path metadata but skips directory content.

## Initial Snapshots

Equip creates an initial `first-detection` snapshot the first time it detects a platform. That initial snapshot should happen before any install, wrap, adopt, or other platform-mutating write.

The initial snapshot is the pre-Equip baseline. If the marker file exists but the referenced snapshot file is gone, Equip treats the marker as stale and captures a new initial snapshot the next time it scans or installs.

## Restore Preview

Before restoring, callers can ask for a JSON diff:

```bash
equip snapshot-diff claude-code
equip snapshot-diff claude-code 20260401T143022Z
equip snapshot-diff claude-code --delete-added
```

The diff is designed for both CLI and UI consumption. It reports one entry per restorable file:

- `kind`: `config` or `rules`
- `path`: absolute file path
- `action`: `unchanged`, `create`, `modify`, `delete`, `preserve-added`, or `skip`
- current and snapshot existence, file kind, byte counts, and SHA-256 hashes
- optional reason text for preserve/delete/skip decisions

The diff intentionally does not include file contents.

## Restore Policies

When a snapshot contains file content, restore may create or modify the current file so it matches the snapshot.

When a snapshot records that a file did not exist, but that file exists now, restore needs a policy:

- `--preserve-added` leaves the current file in place. This is the default.
- `--delete-added` deletes the current file if it is a regular file.

Equip does not delete directories through snapshot restore. Directory paths are reported as `skip` in the diff so the UI or CLI can explain why no destructive action was taken.

## Restoring

```bash
equip restore claude-code
equip restore claude-code 20260401T143022Z
equip restore claude-code --dry-run
equip restore claude-code --delete-added
equip restore claude-code --dry-run --json
```

If no snapshot ID is provided, Equip restores the oldest `first-detection` snapshot. Before applying the restore, Equip captures a `pre-restore` snapshot of the current state so the user can undo the restore by restoring that snapshot ID.

`--dry-run` prints the restore plan and does not write files. With `--json`, it also writes the machine-readable diff to stdout.

## Operational Notes

Snapshots live under `~/.equip/snapshots/<platform>/<snapshot-id>.json`.

Snapshot restore uses the same process lock as other Equip writes, so concurrent Equip commands do not race while applying the restore plan.

Snapshot restore is file-level, not semantic JSON/TOML merging. Restoring a config file writes the exact raw file content from the snapshot. Use `equip snapshot-diff` first when you need to show the user what will change.
