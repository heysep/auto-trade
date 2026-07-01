import {
  readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface HaltState { halted: boolean; reason?: string; }

/** Durable backing for the kill switch so an emergency stop survives a restart. */
export interface HaltStore {
  load(): HaltState | null;     // null ONLY when the switch was never set (file absent)
  save(state: HaltState): void;
}

const FAIL_SAFE: HaltState = { halted: true, reason: 'halt file unreadable/corrupt; failing safe' };

/**
 * JSON file store. Writes ATOMICALLY (temp + fsync + rename) so a crash mid-write can't
 * leave a torn file. Distinguishes "absent" (never tripped -> ok) from "present but
 * corrupt" (unknown -> FAIL SAFE = halted) — a kill switch must never fail open.
 */
export class FileHaltStore implements HaltStore {
  constructor(private readonly path: string) {}

  load(): HaltState | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;   // never set -> ok
      return FAIL_SAFE;                                                    // present but unreadable
    }
    try {
      const p = JSON.parse(raw) as { halted?: unknown; reason?: unknown };
      if (typeof p?.halted !== 'boolean') return FAIL_SAFE;
      return { halted: p.halted, ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) };
    } catch {
      return FAIL_SAFE;                                                    // torn / corrupt JSON
    }
  }

  save(state: HaltState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);                 // flush to disk before the rename
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);       // atomic replace
  }
}
