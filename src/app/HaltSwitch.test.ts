import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { HaltSwitch } from './HaltSwitch.js';
import { FileHaltStore } from './HaltStore.js';

const FILE = join(tmpdir(), `halt-test-${process.pid}.json`);
afterEach(() => { try { rmSync(FILE); } catch { /* */ } });

describe('HaltSwitch durability', () => {
  it('persists a trip and reloads it in a fresh switch (survives restart)', () => {
    const store = new FileHaltStore(FILE);
    new HaltSwitch({ store }).trip('panic');

    const reloaded = new HaltSwitch({ store: new FileHaltStore(FILE) });
    expect(reloaded.halted).toBe(true);
    expect(reloaded.reason).toBe('panic');
  });

  it('persists a reset so a cleared halt stays cleared after restart', () => {
    const store = new FileHaltStore(FILE);
    const sw = new HaltSwitch({ store });
    sw.trip('x');
    sw.reset();
    expect(new HaltSwitch({ store: new FileHaltStore(FILE) }).halted).toBe(false);
  });

  it('defaults to not-halted when no store/file exists', () => {
    expect(new HaltSwitch().halted).toBe(false);
    expect(new HaltSwitch({ store: new FileHaltStore(join(tmpdir(), 'does-not-exist.json')) }).halted).toBe(false);
  });

  it('FAILS SAFE (halted) on a corrupt/partial halt file', () => {
    writeFileSync(FILE, '{"halted":tr');                 // torn write
    expect(new HaltSwitch({ store: new FileHaltStore(FILE) }).halted).toBe(true);
    writeFileSync(FILE, '');                             // empty file
    expect(new HaltSwitch({ store: new FileHaltStore(FILE) }).halted).toBe(true);
  });
});
