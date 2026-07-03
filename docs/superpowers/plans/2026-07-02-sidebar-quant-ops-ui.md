# Sidebar Quant Ops Console UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current TradingView-style monolith dashboard in `server.ts` with a left-sidebar SPA Quant Ops console, migrating every existing feature into named views.

**Architecture:** Extract DASHBOARD_HTML into `src/api/dashboard.ts` (exported template literal). Build incrementally in ≤300-line Write/Edit chunks. Import in server.ts. Update test assertions to match new stable markers.

**Tech Stack:** Vanilla JS (ES5 in template literal), LightweightCharts@4.2.3, Inter font (Google Fonts), CSS custom properties design system.

## Global Constraints

- No React/build steps; no library version changes
- `lightweight-charts@4.2.3` — exact version, no changes
- ES5-style JS inside template literal (var, function, no arrow functions, no template literals, no const/let inside HTML)
- `</script>` inside template literal must be `<\/script>`
- `esc()` on every API string before innerHTML (anti-XSS)
- chart init wrapped in try/catch; handlers wired independent of chart
- 3s poll for: halt, strategies, positions, logs, orders only (NOT ranking/backtest/rebalance)
- Preserve all existing endpoint calls verbatim
- TypeScript strict mode; ESM `.js` imports in server.ts

---

### Task 1: Create dashboard.ts — head + CSS + sidebar

**Files:**
- Create: `src/api/dashboard.ts`

- [ ] Write file with `<head>` (meta, fonts, LW-charts CDN script), full CSS (~200 lines), and sidebar HTML
- [ ] Verify file was created and is valid TS (no syntax errors from backtick escaping)

### Task 2: Append main layout, halt banner, topbar, Dashboard view

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `#main` div, `#halt-banner`, `#topbar`, and `#view-dashboard` section with status badges + metric cards

### Task 3: Append Strategy Lab view

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `#view-lab` section with symbol search, chart container, strategy builder, metrics strip

### Task 4: Append Composed + Factor Ranking + Factor Backtest views

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `#view-composed`, `#view-ranking`, `#view-fbt` sections

### Task 5: Append Trading + Portfolio + Orders views

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `#view-trading`, `#view-portfolio`, `#view-orders` sections

### Task 6: Append Performance + Risk/Halt + Settings views + close HTML

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `#view-performance`, `#view-risk`, `#view-settings` sections, close `</main></div></body></html>`, close template literal

### Task 7: Append JS — utilities, router, chart init, symbol search

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append `<script>` block with esc/jfetch/cell/pct utilities, view router, global state vars, main chart init, lab chart init, symbol search

### Task 8: Append JS — strategy builder, backtest, deploy, refresh functions

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append param fields, buildSpec, backtest handler, deploy handler, refreshAll/refreshPositions/refreshStrategies/refreshLogs/refreshHalt/refreshOrders

### Task 9: Append JS — factor ranking, factor backtest, portfolio rebalance, auto-rebalance, performance, clock

**Files:**
- Modify: `src/api/dashboard.ts`

- [ ] Edit to append all remaining JS: factor ranking, factor backtest, portfolio rebalance, auto-rebalance toggle, performance metrics+chart, sidebar clock, close `</script></body></html>` and template literal

### Task 10: Update server.ts to import DASHBOARD_HTML from dashboard.ts

**Files:**
- Modify: `src/api/server.ts`

- [ ] Read the file to confirm exact lines of `const DASHBOARD_HTML = \`...` start/end
- [ ] Edit to add import at top; delete inline DASHBOARD_HTML const (lines 287–1646)

### Task 11: Update server.test.ts assertions + run tests

**Files:**
- Modify: `src/api/server.test.ts`

- [ ] Change `'auto-trading'` assertion to `'AutoTrade'`
- [ ] Keep `'긴급 정지'` (Risk view has this button)
- [ ] Run `npx vitest run` — verify 362 tests pass
- [ ] Run `npm run typecheck` — verify clean
- [ ] Verify server curl checks

### Task 12: Write report to .superpowers/sdd/ui-redesign-shell-report.md

**Files:**
- Create: `/Users/im-yoseb/auto-trading/.superpowers/sdd/ui-redesign-shell-report.md`

- [ ] Document which view each feature landed in
- [ ] Commit everything with the required message
