// Cross-sectional AQR FactorModel: scores a universe of symbols, standardizes
// factors cross-sectionally, composites with weights, and ranks (long-only top-N).
// Pure/deterministic — no I/O, no Date.now, no Math.random.

import { winsorize, zscore, sectorNeutralize } from './standardize.js';
import { momentum12_1, realizedVol, maxDrawdown } from './priceFactors.js';

export interface FactorWeights {
  value: number;
  momentum: number;
  quality: number;
  defensive: number;
}

export const DEFAULT_WEIGHTS: FactorWeights = {
  value: 0.30,
  momentum: 0.30,
  quality: 0.25,
  defensive: 0.15,
};

export interface UniverseEntry {
  symbol: string;
  sector: string;
  /** Daily closes, oldest → newest */
  prices: number[];
}

export interface Fundamentals {
  /** Raw per-symbol value scores (higher = better) */
  value?: Map<string, number>;
  /** Raw per-symbol quality scores (higher = better) */
  quality?: Map<string, number>;
}

export interface FactorPeriods {
  momSkip: number;
  momLong: number;
  momMid: number;
  volWindow: number;
  mddWindow: number;
}

export const DEFAULT_PERIODS: FactorPeriods = {
  momSkip: 21,
  momLong: 252,
  momMid: 126,
  volWindow: 252,
  mddWindow: 252,
};

export interface ScoredSymbol {
  symbol: string;
  sector: string;
  composite: number;
  rank: number;
  factors: {
    momentum?: number;
    defensive?: number;
    value?: number;
    quality?: number;
  };
}

export class FactorModel {
  private readonly weights: FactorWeights;
  private readonly periods: FactorPeriods;

  constructor(weights?: FactorWeights, periods?: FactorPeriods) {
    this.weights = weights ?? DEFAULT_WEIGHTS;
    this.periods = periods ?? DEFAULT_PERIODS;
  }

  score(universe: UniverseEntry[], fundamentals?: Fundamentals): ScoredSymbol[] {
    const { momSkip, momLong, momMid, volWindow, mddWindow } = this.periods;

    // ── Step 1: filter to scorable entries (all price factors non-null) ──────
    interface RawFactors {
      mom12: number;
      mom6: number;
      vol: number;
      mdd: number;
    }

    const scorable: Array<{ entry: UniverseEntry; raw: RawFactors }> = [];

    for (const entry of universe) {
      const mom12 = momentum12_1(entry.prices, momSkip, momLong);
      const mom6 = momentum12_1(entry.prices, momSkip, momMid);
      const vol = realizedVol(entry.prices, volWindow);
      const mdd = maxDrawdown(entry.prices, mddWindow);

      if (mom12 !== null && mom6 !== null && vol !== null && mdd !== null) {
        scorable.push({ entry, raw: { mom12, mom6, vol, mdd } });
      }
    }

    // If fewer than 2 scorable entries, return them with composite=0, rank by symbol
    if (scorable.length < 2) {
      const sorted = [...scorable].sort((a, b) =>
        a.entry.symbol.localeCompare(b.entry.symbol),
      );
      return sorted.map((s, i) => ({
        symbol: s.entry.symbol,
        sector: s.entry.sector,
        composite: 0,
        rank: i + 1,
        factors: {},
      }));
    }

    const sectors = scorable.map((s) => s.entry.sector);

    // ── Step 2: Momentum factor ───────────────────────────────────────────────
    const rawMom12 = scorable.map((s) => s.raw.mom12);
    const rawMom6 = scorable.map((s) => s.raw.mom6);

    const zMom12 = zscore(winsorize(rawMom12));
    const zMom6 = zscore(winsorize(rawMom6));

    const momentumRaw = zMom12.map((z12, i) => {
      const z6 = zMom6[i] ?? 0;
      return (z12 + z6) / 2;
    });
    const momentumScore = sectorNeutralize(momentumRaw, sectors);

    // ── Step 3: Defensive factor ─────────────────────────────────────────────
    const rawVol = scorable.map((s) => s.raw.vol);
    const rawMdd = scorable.map((s) => s.raw.mdd);

    const zVol = zscore(winsorize(rawVol));
    const zMdd = zscore(winsorize(rawMdd));

    const defensiveRaw = zVol.map((zv, i) => {
      const zm = zMdd[i] ?? 0;
      return (-zv + -zm) / 2;
    });
    const defensiveScore = sectorNeutralize(defensiveRaw, sectors);

    // ── Step 4: Value factor (optional) ──────────────────────────────────────
    let valueScore: number[] | null = null;
    if (fundamentals?.value !== undefined) {
      const valMap = fundamentals.value;
      const allPresent = scorable.every((s) => valMap.has(s.entry.symbol));
      if (allPresent) {
        const rawVal = scorable.map((s) => valMap.get(s.entry.symbol) as number);
        valueScore = sectorNeutralize(zscore(winsorize(rawVal)), sectors);
      }
    }

    // ── Step 5: Quality factor (optional) ────────────────────────────────────
    let qualityScore: number[] | null = null;
    if (fundamentals?.quality !== undefined) {
      const qualMap = fundamentals.quality;
      const allPresent = scorable.every((s) => qualMap.has(s.entry.symbol));
      if (allPresent) {
        const rawQual = scorable.map((s) => qualMap.get(s.entry.symbol) as number);
        qualityScore = sectorNeutralize(zscore(winsorize(rawQual)), sectors);
      }
    }

    // ── Step 6: Composite with renormalized weights ───────────────────────────
    const presentFactors: Array<{ scores: number[]; weight: number; key: 'momentum' | 'defensive' | 'value' | 'quality' }> = [
      { scores: momentumScore, weight: this.weights.momentum, key: 'momentum' },
      { scores: defensiveScore, weight: this.weights.defensive, key: 'defensive' },
    ];
    if (valueScore !== null) {
      presentFactors.push({ scores: valueScore, weight: this.weights.value, key: 'value' });
    }
    if (qualityScore !== null) {
      presentFactors.push({ scores: qualityScore, weight: this.weights.quality, key: 'quality' });
    }

    const totalWeight = presentFactors.reduce((s, f) => s + f.weight, 0);

    const composites = scorable.map((_, i) =>
      presentFactors.reduce((sum, f) => {
        const score = f.scores[i] ?? 0;
        return sum + (f.weight / totalWeight) * score;
      }, 0),
    );

    // ── Step 7: Sort DESC, assign ranks ──────────────────────────────────────
    const indexed = composites.map((c, i) => ({ c, i }));
    // Stable sort: use input order as tiebreaker
    indexed.sort((a, b) => b.c - a.c);

    const result: ScoredSymbol[] = indexed.map(({ c, i }, rank) => {
      const s = scorable[i];
      if (s === undefined) throw new Error('internal: scorable index out of bounds');

      const factorEntry = s.entry;
      const factors: ScoredSymbol['factors'] = {
        ...(momentumScore[i] !== undefined ? { momentum: momentumScore[i] } : {}),
        ...(defensiveScore[i] !== undefined ? { defensive: defensiveScore[i] } : {}),
        ...(valueScore !== null && valueScore[i] !== undefined ? { value: valueScore[i] } : {}),
        ...(qualityScore !== null && qualityScore[i] !== undefined ? { quality: qualityScore[i] } : {}),
      };

      return {
        symbol: factorEntry.symbol,
        sector: factorEntry.sector,
        composite: c,
        rank: rank + 1,
        factors,
      };
    });

    return result;
  }
}
