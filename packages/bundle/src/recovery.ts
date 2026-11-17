import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Owner { version: 1; pid: number }
export interface GenerationClaim { release(): void }

/**
 * Hold this lock throughout all bridge and snapshot operations for a session.
 * Lock databases must never be unlinked: unlinking permits split-brain locks.
 * This requires a local filesystem with correct SQLite advisory locking.
 */
export function acquireSessionLock(namespaceRoot: string, sessionId: string, warn: (message: string) => void): GenerationClaim | undefined {
  let db: DatabaseSync | undefined;
  try {
    const locks = join(namespaceRoot, ".session-locks");
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(sessionId).digest("hex");
    db = new DatabaseSync(join(locks, `${name}.sqlite`));
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  } catch (error) {
    try { db?.close(); } catch { /* Leave the failure visible through the warning. */ }
    warn(`session lock unavailable for ${sessionId}: ${String(error)}`);
    return undefined;
  }
  const held = db;
  let released = false;
  return {
    release() {
      if (released) return;
      held.exec("ROLLBACK");
      held.close();
      released = true;
    },
  };
}

/** Create ownership metadata before exposing a generation to the outbox writer. */
/** Mark a generation after this process has completed its final snapshot write. */
export function retireGeneration(dir: string): void {
  // Atomic rename prevents a startup reader from observing a partial marker.
  const marker = join(dir, "retired.json");
  writeFileSync(`${marker}.tmp`, JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600 });
  renameSync(`${marker}.tmp`, marker);
}

export function createGeneration(namespaceRoot: string): string {
  mkdirSync(namespaceRoot, { recursive: true, mode: 0o700 });
  const dir = join(namespaceRoot, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  // An interrupted write leaves an unrecognised generation, which is preserved.
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600, flag: "wx" });
  return dir;
}

/**
 * Claims only an owner known to be absent on this machine. Existing claims are
 * never stolen: even a dead claimant may have crashed before recording its PID.
 * An operator can recover such a claim only after stopping all contenders.
 */
export function claimAbandoned(dir: string, warn: (message: string) => void): GenerationClaim | undefined {
  let owner: Owner;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid owner");
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0 || candidate.pid > 2147483647) throw new Error("invalid owner");
    owner = { version: 1, pid: candidate.pid };
  } catch (error) {
    warn(`preserved generation ${dir}: unknown owner (${String(error)})`);
    return undefined;
  }
  try {
    const retired: unknown = JSON.parse(readFileSync(join(dir, "retired.json"), "utf8"));
    if (!retired || typeof retired !== "object" || !("version" in retired) || retired.version !== 1 || !("pid" in retired) || retired.pid !== owner.pid) throw new Error("invalid retired marker");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      warn(`preserved generation ${dir}: owner is not confirmed retired (${String(error)})`);
      return undefined;
    }
    try {
      process.kill(owner.pid, 0);
      return undefined;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        warn(`preserved generation ${dir}: owner process state unknown (${String(error)})`);
        return undefined;
      }
    }
  }
  const claimDir = join(dir, "claim");
  try {
    mkdirSync(claimDir, { mode: 0o700 });
  } catch (error) {
    warn(`preserved generation ${dir}: claim unavailable (${String(error)})`);
    return undefined;
  }
  const token = randomUUID();
  const claimOwner = join(claimDir, "owner.json");
  try {
    writeFileSync(claimOwner, JSON.stringify({ version: 1, pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    warn(`preserved generation ${dir}: claim metadata could not be written (${String(error)})`);
    return undefined;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      const current: unknown = JSON.parse(readFileSync(claimOwner, "utf8"));
      if (!current || typeof current !== "object" || !("token" in current) || current.token !== token) throw new Error(`claim ownership changed for ${dir}`);
      unlinkSync(claimOwner);
      rmdirSync(claimDir);
      released = true;
    },
  };
}
