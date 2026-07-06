// FactorPortfolioManager: top-N equal-weight AQR factor portfolio rebalancer.
//
// Pure orchestration — all side-effects injected via FactorPortfolioDeps.
// Concerns in scope:
//   - Halt-awareness: no orders when halted.
//   - Equal-weight targeting: perName = totalNotional / topN.
//   - Exit detection: symbols currently held but dropped from the new top-N get a full exit.
//   - Delta sizing: floor(perName / price) − currentQty.
//   - Order sequencing: all SELLs (exits + delta reductions) before any BUYs.
//   - Per-order failure isolation: one bad submitIntent must not abort the whole rebalance.
//
// Out of scope for this chunk: HTTP/engine/registry wiring, live/paper gating,
// OrderManager integration (that is the next wiring chunk).

import type { Currency, TradingMode } from '../domain/types.js';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A richer order intent used internally by FactorPortfolioManager.
 * Unlike the simpler OrderIntent in src/strategy/Strategy.ts, this carries the
 * symbol, strategyId, currency and mode so that the injected submitIntent closure
 * has enough context to build an OrderManager call in production.
 *
 * NOTE for the wiring chunk: map this to
 *   OrderManager.handleIntent(strategy, { side, quantity, orderType, reason }, quote)
 * where `quote` is looked up by intent.symbol.
 */
export interface PortfolioOrderIntent {
  strategyId: number;
  symbol: string;
  currency: Currency;
  mode: TradingMode;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET';
  reason: string;
}

export interface RebalanceConfig {
  strategyId: number;
  topN: number;
  totalNotional: number;
  currency: Currency;
  mode: TradingMode;
}

export interface TargetHolding {
  symbol: string;
  targetNotional: number;
  price: number;
  targetQty: number;
  currentQty: number;
  deltaQty: number;
}

export interface RebalancePlan {
  asOf: number;
  /** The intended top-N holdings (may exclude symbols with no price). */
  targets: TargetHolding[];
  /** Symbols currently held that dropped out of the top-N (full exits). */
  sells: { symbol: string; qty: number }[];
  /** Orders that were successfully submitted (side + qty for each). */
  ordersSubmitted: { symbol: string; side: 'BUY' | 'SELL'; qty: number }[];
  /** Symbols skipped due to 'no price' or a submitIntent error. */
  skipped: { symbol: string; reason: string }[];
  /** True when the halt switch was active; no orders are submitted. */
  halted: boolean;
}

export interface FactorPortfolioDeps {
  /** Factor ranking service. rank(limit) returns scored[] sorted by rank. */
  ranking: { rank: (limit?: number) => Promise<{ scored: { symbol: string }[] }> };
  /** Current held quantity for a symbol in this strategy/mode (0 if none). */
  currentQty: (symbol: string) => number;
  /** All symbols this strategy currently holds with non-zero quantity. */
  heldSymbols: () => string[];
  /** Latest price for a symbol; undefined = no quote available. */
  priceOf: (symbol: string) => number | undefined;
  /**
   * Routes an order intent toward the broker in production.
   * Accepts a PortfolioOrderIntent (not the narrower Strategy.ts OrderIntent).
   * The wiring chunk adapts this to OrderManager.handleIntent.
   */
  submitIntent: (intent: PortfolioOrderIntent) => Promise<void>;
  /** Returns true when the trading halt switch is active. */
  isHalted: () => boolean;
  /** Clock injection; defaults to Date.now. */
  now?: () => number;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class FactorPortfolioManager {
  private readonly now: () => number;

  constructor(
    private readonly deps: FactorPortfolioDeps,
    private readonly config: RebalanceConfig,
  ) {
    this.now = deps.now ?? Date.now;
  }

  async rebalance(): Promise<RebalancePlan> {
    // ── Step 1: Halt check ──────────────────────────────────────────────────
    if (this.deps.isHalted()) {
      return {
        asOf: this.now(),
        targets: [],
        sells: [],
        ordersSubmitted: [],
        skipped: [],
        halted: true,
      };
    }

    const { strategyId, topN, totalNotional, currency, mode } = this.config;
    // Alias to avoid shadowing by local `currentQty` variables inside the loop.
    const getQty = this.deps.currentQty;

    // ── Step 2: Get a deeper ranking pool for affordability-fill ───────────
    // Request topN * 5 candidates so we can walk past unaffordable top-ranked
    // symbols and still fill all topN slots with affordable ones.
    const rankResult = await this.deps.ranking.rank(topN * 5);
    const rankedSymbols = rankResult.scored.map((s) => s.symbol);

    const targets: TargetHolding[] = [];
    const skipped: { symbol: string; reason: string }[] = [];
    const sells: { symbol: string; qty: number }[] = [];
    const ordersSubmitted: { symbol: string; side: 'BUY' | 'SELL'; qty: number }[] = [];

    const perName = totalNotional / topN;

    // ── Step 3: Affordability-fill — walk ranked list, fill slots ──────────
    // A slot is consumed only when floor(perName / price) >= 1.
    // Symbols with no price   → skipped('no price'),    slot NOT consumed.
    // Symbols with qty < 1    → skipped('unaffordable'), slot NOT consumed.
    // We stop as soon as topN slots are filled (extra ranked symbols are not
    // even inspected, so they never appear in `skipped`).
    for (const symbol of rankedSymbols) {
      if (targets.length >= topN) break;

      const price = this.deps.priceOf(symbol);
      if (price === undefined) {
        skipped.push({ symbol, reason: 'no price' });
        continue;
      }
      const targetQty = Math.floor(perName / price);
      if (targetQty < 1) {
        skipped.push({ symbol, reason: 'unaffordable' });
        continue;
      }
      const currentQty = getQty(symbol);
      const deltaQty = targetQty - currentQty;
      targets.push({ symbol, targetNotional: perName, price, targetQty, currentQty, deltaQty });
    }

    // targetSet is derived from filled slots only (not the raw ranked list).
    const targetSet = new Set(targets.map((t) => t.symbol));

    // ── Step 4: Identify exits ──────────────────────────────────────────────
    for (const symbol of this.deps.heldSymbols()) {
      if (!targetSet.has(symbol)) {
        sells.push({ symbol, qty: getQty(symbol) });
      }
    }

    // ── Step 5: Submit orders — SELLS first, then BUYS ─────────────────────
    //
    // Ordering rationale: freeing cash from exits and reductions before
    // opening / increasing positions avoids momentary over-exposure.
    //
    // (a) Full exits for dropped symbols.
    for (const { symbol, qty } of sells) {
      const intent: PortfolioOrderIntent = {
        strategyId,
        symbol,
        currency,
        mode,
        side: 'SELL',
        quantity: qty,
        orderType: 'MARKET',
        reason: 'rebalance exit SELL',
      };
      try {
        await this.deps.submitIntent(intent);
        ordersSubmitted.push({ symbol, side: 'SELL', qty });
      } catch (err) {
        skipped.push({
          symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (b) Delta reductions (held > target) — still SELLs, so before BUYs.
    const deltaSells = targets.filter((t) => t.deltaQty < 0);
    const deltaBuys = targets.filter((t) => t.deltaQty > 0);

    for (const target of deltaSells) {
      const { symbol, deltaQty } = target;
      const quantity = Math.abs(deltaQty);
      const intent: PortfolioOrderIntent = {
        strategyId,
        symbol,
        currency,
        mode,
        side: 'SELL',
        quantity,
        orderType: 'MARKET',
        reason: 'rebalance delta SELL',
      };
      try {
        await this.deps.submitIntent(intent);
        ordersSubmitted.push({ symbol, side: 'SELL', qty: quantity });
      } catch (err) {
        skipped.push({
          symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (c) Delta increases (new or under-weight positions) — BUYs last.
    for (const target of deltaBuys) {
      const { symbol, deltaQty } = target;
      const quantity = deltaQty; // already positive
      const intent: PortfolioOrderIntent = {
        strategyId,
        symbol,
        currency,
        mode,
        side: 'BUY',
        quantity,
        orderType: 'MARKET',
        reason: 'rebalance delta BUY',
      };
      try {
        await this.deps.submitIntent(intent);
        ordersSubmitted.push({ symbol, side: 'BUY', qty: quantity });
      } catch (err) {
        skipped.push({
          symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Step 6: Return plan ─────────────────────────────────────────────────
    return {
      asOf: this.now(),
      targets,
      sells,
      ordersSubmitted,
      skipped,
      halted: false,
    };
  }
}
