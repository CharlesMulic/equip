// Append-only intent journal — the canonical write surface for storage.
//
// Each line of `~/.equip/storage/intents.jsonl` is one Intent serialized as
// JSON (no embedded newlines, terminated with \n). Writes use Node's
// fs.appendFileSync which translates to O_APPEND on POSIX — atomic for
// writes ≤ PIPE_BUF (~4KB). Intents fit comfortably under that limit.
//
// Reads stream the file line-by-line, parsing each as Intent. Corrupt lines
// (parse failures, schema mismatches) are logged + skipped — defensive
// against journal corruption without blocking the rest of the system.
//
// Multi-writer safety: O_APPEND handles concurrent appenders correctly on
// POSIX. On Windows, fs.appendFile uses CreateFile with FILE_APPEND_DATA
// which has the same atomicity guarantee. Any cooperating writer can append
// without coordination.

import * as fs from "fs";
import * as path from "path";
import { getEquipHome } from "../equip-home";
import { posixMode } from "../posix-mode";
import { type Intent, isIntent } from "./intent";

const STORAGE_JOURNAL_FILENAME = "storage/intents.jsonl";

function getJournalPath(): string {
  return path.join(getEquipHome(), STORAGE_JOURNAL_FILENAME);
}

function ensureJournalDir(): void {
  const dir = path.dirname(getJournalPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: posixMode(0o700) });
  }
}

/**
 * Append an intent to the journal. Atomic — single-line write via
 * Node's fs.appendFileSync (translates to O_APPEND on POSIX).
 *
 * Throws if the intent serializes to >4KB (would lose atomicity guarantee).
 */
export function appendIntent(intent: Intent): void {
  ensureJournalDir();
  const line = JSON.stringify(intent) + "\n";
  if (Buffer.byteLength(line, "utf-8") > 4096) {
    throw new Error(
      `Intent too large for atomic append (>${4096} bytes). ` +
      `Type=${intent.type} name=${intent.name}. ` +
      `Large content goes in content-store, not the intent.`,
    );
  }
  fs.appendFileSync(getJournalPath(), line, { encoding: "utf-8", mode: posixMode(0o600) });
}

/**
 * Read all intents from the journal. Returns them in append order (which
 * matches clock order for single-writer scenarios; multi-writer scenarios
 * may need clock-based sort.
 *
 * Corrupt lines (parse failures, schema mismatches) are skipped with a
 * stderr warning. Defensive — a single bad line shouldn't block the rest.
 */
export function readIntents(): Intent[] {
  const p = getJournalPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const intents: Intent[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (isIntent(parsed)) {
        intents.push(parsed);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[equip v2 journal] line ${i + 1}: parsed but not a valid Intent shape; skipping`);
      }
    } catch (parseErr) {
      // eslint-disable-next-line no-console
      console.warn(`[equip v2 journal] line ${i + 1}: JSON parse failed; skipping. ${(parseErr as Error).message}`);
    }
  }
  return intents;
}

/**
 * Read all intents for a specific augment. Common materializer query: fold
 * the per-augment slice instead of the whole journal.
 */
export function readIntentsFor(name: string): Intent[] {
  return readIntents().filter((i) => i.name === name);
}

/**
 * Total intent count. Used by tests to check append happened.
 */
export function journalSize(): number {
  return readIntents().length;
}

// ─── Clock helpers ────────────────────────────────────────

let _seqCounter = 0;
let _seqInitialized = false;

/**
 * Returns the next sequence number for this process. Initialized lazily by
 * scanning the existing journal for the maximum seq + 1, so that restarts
 * don't collide.
 */
export function nextSeq(): number {
  if (!_seqInitialized) {
    let max = -1;
    for (const intent of readIntents()) {
      if (intent.clock.seq > max) max = intent.clock.seq;
    }
    _seqCounter = max + 1;
    _seqInitialized = true;
  }
  return _seqCounter++;
}

/**
 * Reset the in-memory seq counter. ONLY for tests after creating a fresh
 * journal — production code never calls this.
 */
export function _resetSeqForTests(): void {
  _seqInitialized = false;
  _seqCounter = 0;
}

/**
 * Stable node identifier. Multi-device sync can later derive this from a
 * per-machine UUID stored in user config.
 */
export function getNodeId(): string {
  return "local-node";
}
