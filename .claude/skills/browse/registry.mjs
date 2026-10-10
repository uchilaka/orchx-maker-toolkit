// The registry of running /browse servers: one JSON file per server, named by
// its port, in ~/.claude/state/browse (BROWSE_STATE_DIR overrides it; the tests
// use that). Like a pidfile, an entry can outlive its server after a SIGKILL,
// so readers must check it's still live before trusting it.
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir() {
  return process.env.BROWSE_STATE_DIR || join(homedir(), ".claude", "state", "browse");
}

export const entryFile = (port) => join(stateDir(), `${port}.json`);

// Who started the server. "shared" (the session-start autostart, or anything run
// outside Claude Code) is never stopped by a session's "done".
export function ownerFromEnv(env = process.env) {
  return env.BROWSE_OWNER || env.CLAUDE_CODE_SESSION_ID || "shared";
}

// Write to a temp file and rename, so a reader never sees half an entry.
export function writeEntry(entry) {
  mkdirSync(stateDir(), { recursive: true });
  const file = entryFile(entry.port);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, file);
}

export function readEntry(port) {
  try {
    return JSON.parse(readFileSync(entryFile(port), "utf8"));
  } catch {
    return null;
  }
}

// Remove the entry for <port> only if it still names <pid>: a server that
// exits late must not delete the entry of a newer server on the same port.
export function removeEntry(port, pid) {
  if (readEntry(port)?.pid !== pid) return;
  try {
    unlinkSync(entryFile(port));
  } catch {
    // already gone
  }
}
