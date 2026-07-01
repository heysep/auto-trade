# Task 10a Report — Dynamic Strategy Deployment Core

## Status
COMPLETE

## What Was Implemented

### 1. `src/market/WatchList.ts`
- `WatchEntry` interface: `{ symbol: string; market: 'KR' | 'US' }`
- `WatchList` class with `add(entry)` (idempotent by symbol), `remove(symbol)`, and `list()` methods
- Internal storage uses `Map<string, WatchEntry>` keyed by symbol for O(1) idempotency

### 2. `src/strategy/StrategyRegistry.ts` — added `remove(id)`
- `remove(id: number): boolean` — deletes the entry and returns `true` if it existed, `false` otherwise
- Delegates to `Map.delete()` which already returns a boolean

### 3. `src/app/StrategyDeployer.ts`
- `DeployRecord` interface: `{ id: number; symbol: string; name: string; spec: StrategySpec }`
- `StrategyDeployerDeps` interface with engine, registry, watchList, currency, mode, optional onChange
- `StrategyDeployer` class:
  - `deploy()`: assigns nextId, calls `buildStrategy`, registers with engine+registry as PAPER_TESTING, adds to watchList, stores record, calls onChange
  - `undeploy()`: unregisters from engine+registry, drops record, removes from watchList only if no other record shares the symbol, calls onChange
  - `records()`: snapshot of current deployed records
  - `restore()`: rebuilds all records (no onChange), advances id counter to `max(startId, maxId+1)`

### 4. Tests Added
- `src/market/WatchList.test.ts`: 7 tests
- `src/strategy/StrategyRegistry.test.ts`: 3 new tests (remove semantics)
- `src/app/StrategyDeployer.test.ts`: 13 tests (deploy, undeploy, records, restore, shared-symbol guard, id counter, KR/US market)

## Test Summary
28 test files, 155 tests — all passed (was 132 before this task; 23 new tests added).

## Commit Hash
(see git log)

## Concerns
None. The implementation is straightforward and all edge cases (shared symbol guard, id floor at startId, restore without onChange) are covered by tests.
