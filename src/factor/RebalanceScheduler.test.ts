import { describe, it, expect, vi } from 'vitest';
import { RebalanceScheduler } from './RebalanceScheduler.js';

describe('RebalanceScheduler', () => {
  describe('tick()', () => {
    it('calls rebalance and records ok when trading day and not halted', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        now: () => 9000,
      });
      await s.tick();
      expect(called).toBe(true);
      expect(s.lastRun()).toEqual({ at: 9000, ok: true });
    });

    it('skips rebalance and records halted note when halted', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => true,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      await s.tick();
      expect(called).toBe(false);
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'halted' });
    });

    it('skips rebalance on non-trading day', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => false,
        isTradingDay: () => false,
        intervalMs: 1000,
      });
      await s.tick();
      expect(called).toBe(false);
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'not a trading day' });
    });

    it('catches rebalance errors, records ok:false with message, does not throw', async () => {
      const s = new RebalanceScheduler({
        rebalance: async () => { throw new Error('fetch failed'); },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        now: () => 5000,
      });
      await expect(s.tick()).resolves.toBeUndefined();
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'fetch failed' });
    });

    it('logs the error via logger when rebalance throws', async () => {
      const logged: unknown[] = [];
      const s = new RebalanceScheduler({
        rebalance: async () => { throw new Error('boom'); },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        logger: { log: (e) => logged.push(e) },
      });
      await s.tick();
      expect(logged).toHaveLength(1);
    });

    it('overlap guard: second tick() during in-flight rebalance does not call rebalance again', async () => {
      let callCount = 0;
      let resolveRebalance!: () => void;
      const s = new RebalanceScheduler({
        rebalance: () => new Promise<void>((res) => { callCount++; resolveRebalance = res; }),
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      const t1 = s.tick();   // starts, hangs
      const t2 = s.tick();   // should skip silently (in-flight)
      await t2;               // resolves immediately
      resolveRebalance();     // let t1 finish
      await t1;
      expect(callCount).toBe(1);
    });
  });

  describe('start() / stop() / enabled', () => {
    it('start() arms the injected setInterval; stop() clears it; enabled reflects state', () => {
      const intervalCalls: number[] = [];
      const clearCalls: unknown[] = [];
      const handles: object[] = [];
      const setIntervalFn = (_fn: () => void, ms: number) => {
        const h = {} as ReturnType<typeof setInterval>;
        handles.push(h);
        intervalCalls.push(ms);
        return h;
      };
      const clearIntervalFn = (h: ReturnType<typeof setInterval>) => clearCalls.push(h);

      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 86_400_000,
        setIntervalFn,
        clearIntervalFn,
      });

      expect(s.enabled).toBe(false);
      s.start();
      expect(s.enabled).toBe(true);
      expect(intervalCalls).toHaveLength(1);
      expect(intervalCalls[0]).toBe(86_400_000);

      s.start(); // idempotent — must not arm a second interval
      expect(intervalCalls).toHaveLength(1);

      s.stop();
      expect(s.enabled).toBe(false);
      expect(clearCalls).toHaveLength(1);
      expect(clearCalls[0]).toBe(handles[0]);
    });

    it('stop() is safe when not started', () => {
      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      expect(() => s.stop()).not.toThrow();
    });
  });

  describe('intervalMs getter', () => {
    it('exposes the configured intervalMs', () => {
      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 7200_000,
      });
      expect(s.intervalMs).toBe(7200_000);
    });
  });
});
