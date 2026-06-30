import { describe, it, expect } from 'vitest';
import { InMemoryEventLogger } from './EventLogger.js';

describe('InMemoryEventLogger', () => {
  it('ring-buffers to the cap, dropping oldest', () => {
    const log = new InMemoryEventLogger(3);
    for (let i = 0; i < 5; i++) log.log({ type: 'T', message: String(i), at: i });
    expect(log.events).toHaveLength(3);
    expect(log.events.map((e) => e.message)).toEqual(['2', '3', '4']);   // oldest two dropped
  });

  it('filters by type', () => {
    const log = new InMemoryEventLogger();
    log.log({ type: 'A', at: 0 });
    log.log({ type: 'B', at: 1 });
    log.log({ type: 'A', at: 2 });
    expect(log.ofType('A')).toHaveLength(2);
  });
});
