export const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="application-name" content="auto-trading">
<title>AutoTrade &mdash; Quant Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"><\/script>
<style>
:root{
  --bg:#0f172a;--card:#1e293b;--sidebar:#0b1120;
  --border:rgba(255,255,255,.08);--primary:#3b82f6;
  --bull:#22c55e;--bear:#ef4444;--warning:#f59e0b;
  --fg:#e5e7eb;--muted:#94a3b8;--radius:6px;
  color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg);color:var(--fg);
  font:13px/1.5 'Inter',system-ui,sans-serif;
  display:flex;height:100vh;overflow:hidden;
}
/* sidebar */
#sidebar{
  width:208px;flex-shrink:0;background:var(--sidebar);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden;
}
.sb-logo{
  padding:14px 16px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px;flex-shrink:0;
}
.sb-logo-icon{
  width:28px;height:28px;background:var(--primary);
  border-radius:8px;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;box-shadow:0 0 16px rgba(59,130,246,.3);
}
.sb-logo-icon svg{color:#fff}
.sb-logo-name{font-size:12px;font-weight:700;letter-spacing:-.01em;color:var(--fg)}
.sb-logo-sub{font-size:10px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,monospace}
.sb-pills{
  padding:10px 12px;border-bottom:1px solid var(--border);
  display:flex;gap:6px;flex-shrink:0;
}
.pill{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 8px;border-radius:20px;
  font-size:10px;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace;
  border:1px solid transparent;
}
.pill-paper{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3);color:#60a5fa}
.pill-live{background:rgba(100,116,139,.12);border-color:var(--border);color:var(--muted)}
.pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:sbpulse 2s infinite}
@keyframes sbpulse{0%,100%{opacity:1}50%{opacity:.35}}
/* nav */
#nav{flex:1;overflow-y:auto;padding:8px 0;scrollbar-width:none}
#nav::-webkit-scrollbar{display:none}
.nav-group-hdr{
  padding:8px 16px 3px;font-size:9px;font-weight:600;
  color:var(--muted);text-transform:uppercase;letter-spacing:.12em;
}
.nav-item{
  position:relative;display:flex;align-items:center;gap:8px;
  width:100%;padding:7px 16px;border:0;background:none;
  color:var(--muted);font:inherit;font-size:12px;font-weight:500;
  cursor:pointer;text-align:left;transition:background .12s,color .12s;
}
.nav-item:hover{background:rgba(255,255,255,.04);color:var(--fg)}
.nav-item.active{background:rgba(59,130,246,.1);color:var(--fg)}
.nav-item.active::before{
  content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);
  width:3px;height:20px;background:var(--primary);border-radius:0 3px 3px 0;
}
.nav-item svg{flex-shrink:0;opacity:.7}
.nav-item.active svg{opacity:1;color:var(--primary)}
.nav-halt-dot{
  margin-left:auto;width:6px;height:6px;border-radius:50%;
  background:var(--bear);animation:sbpulse 1s infinite;
}
/* sidebar bottom */
.sb-status{padding:10px 14px;border-top:1px solid var(--border);flex-shrink:0}
.sb-status-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.sb-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sb-status-dot.ok{background:var(--bull);animation:sbpulse 3s infinite}
.sb-status-dot.halt{background:var(--bear);animation:sbpulse 1s infinite}
.sb-clock{font-size:10px;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--muted)}
/* main area */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
/* halt banner */
#halt-banner{
  background:var(--bear);color:#fff;flex-shrink:0;
  border-bottom:1px solid rgba(255,255,255,.15);display:none;
}
.hb-full{display:flex;align-items:flex-start;justify-content:space-between;padding:10px 16px;gap:12px}
.hb-title{font-size:13px;font-weight:700;letter-spacing:.02em}
.hb-sub{font-size:11px;margin-top:3px;color:rgba(255,255,255,.8)}
.hb-compact{
  width:100%;border:0;background:rgba(239,68,68,.85);color:#fff;
  padding:5px;cursor:pointer;font:inherit;font-size:11px;font-weight:600;
  display:none;align-items:center;justify-content:center;gap:6px;
}
/* topbar */
#topbar{
  height:44px;background:var(--card);border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;flex-shrink:0;
}
#topbar-title{font-size:13px;font-weight:600;color:var(--fg)}
.topbar-right{display:flex;align-items:center;gap:12px}
.mkt-ticker{
  display:flex;align-items:center;gap:12px;
  font-size:11px;font-family:ui-monospace,SFMono-Regular,monospace;
}
.mkt-item{display:flex;align-items:center;gap:5px}
.mkt-dot{width:6px;height:6px;border-radius:50%}
.tb-div{width:1px;height:16px;background:var(--border)}
/* content */
#content{
  flex:1;overflow-y:auto;padding:20px;
  scrollbar-width:thin;scrollbar-color:var(--border) transparent;
}
#content::-webkit-scrollbar{width:4px}
#content::-webkit-scrollbar-track{background:transparent}
#content::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
/* cards */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.card+.card{margin-top:12px}
/* metric grid */
.metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.metric-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px}
.metric-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.metric-val{font-size:18px;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--fg)}
/* status badges */
.badge-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;
  font-family:ui-monospace,SFMono-Regular,monospace;border:1px solid transparent;
}
.badge-bull{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3);color:#4ade80}
.badge-bear{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3);color:#f87171}
.badge-primary{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3);color:#60a5fa}
.badge-muted{background:rgba(100,116,139,.1);border-color:var(--border);color:var(--muted)}
.badge-warn{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.3);color:#fbbf24}
/* buttons */
.btn{
  display:inline-flex;align-items:center;gap:6px;padding:6px 14px;
  border-radius:var(--radius);border:1px solid transparent;
  font:inherit;font-size:12px;font-weight:500;cursor:pointer;
  transition:background .12s;
}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.btn-primary:hover:not(:disabled){background:#2563eb}
.btn-danger{background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.3)}
.btn-danger:hover:not(:disabled){background:rgba(239,68,68,.2)}
.btn-ghost{background:rgba(59,130,246,.1);color:#60a5fa;border-color:rgba(59,130,246,.25)}
.btn-ghost:hover:not(:disabled){background:rgba(59,130,246,.18)}
.btn-success{background:rgba(34,197,94,.1);color:#4ade80;border-color:rgba(34,197,94,.25)}
.btn-success:hover:not(:disabled){background:rgba(34,197,94,.18)}
/* tables */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04)}
th{
  color:var(--muted);font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:.06em;position:sticky;top:0;background:var(--card);z-index:1;
}
tr:hover td{background:rgba(255,255,255,.02)}
td.num{text-align:right;font-family:ui-monospace,SFMono-Regular,monospace}
.pos{color:var(--bull)}.neg{color:var(--bear)}.neu{color:var(--fg)}
/* forms */
input[type="text"],input[type="number"],input[type="password"],select,input[type="search"]{
  background:rgba(15,23,42,.8);color:var(--fg);
  border:1px solid var(--border);border-radius:var(--radius);
  padding:6px 10px;font:inherit;font-size:12px;outline:none;
}
input[type="text"]:focus,input[type="number"]:focus,
input[type="password"]:focus,select:focus,input[type="search"]:focus{
  border-color:rgba(59,130,246,.6);
}
/* view sections */
.view-section{display:none}
.view-section.active{display:block}
/* layout helpers */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.row-flex{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* chart containers */
.chart-wrap{position:relative;height:280px;border-radius:var(--radius);overflow:hidden;background:#0a0f1e}
.chart-wrap-sm{position:relative;height:200px;border-radius:var(--radius);overflow:hidden;background:#0a0f1e}
.chart-div{width:100%;height:100%}
.chart-hint{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  color:rgba(148,163,184,.25);font-size:12px;pointer-events:none;
  white-space:nowrap;text-align:center;
}
/* symbol search */
.sym-search-wrap{margin-bottom:8px}
.sym-search-wrap input{width:100%}
.sym-list-box{
  max-height:200px;overflow-y:auto;border:1px solid var(--border);
  border-radius:var(--radius);background:rgba(11,17,32,.95);
}
.sym-item{
  padding:7px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04);
  transition:background .1s;
}
.sym-item:last-child{border-bottom:0}
.sym-item:hover{background:rgba(255,255,255,.04)}
.sym-item.active{background:rgba(59,130,246,.1);border-left:2px solid var(--primary)}
.sym-name{color:var(--fg);font-size:12px}
.sym-code{color:var(--muted);font-size:10px;font-family:ui-monospace,SFMono-Regular,monospace}
.sym-tag{display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;
  background:rgba(255,255,255,.08);color:var(--muted);margin-left:4px}
/* interval tabs */
.int-tabs{display:flex;gap:2px;margin-bottom:8px}
.int-btn{
  background:none;border:1px solid var(--border);color:var(--muted);
  border-radius:4px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;
}
.int-btn:hover{color:var(--fg);border-color:rgba(255,255,255,.2)}
.int-btn.active{background:rgba(59,130,246,.15);color:#60a5fa;border-color:rgba(59,130,246,.3)}
/* strategy builder */
.bsec{padding:12px 16px;border-bottom:1px solid var(--border)}
.bsec:last-child{border-bottom:0}
.bsec-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px}
.brow{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.blabel{color:var(--muted);font-size:11px;min-width:14px;flex-shrink:0;font-weight:600}
.brow select{flex:1}
.and-or-group{display:flex;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.and-or-group button{
  background:none;border:0;color:var(--muted);padding:4px 14px;
  cursor:pointer;font:inherit;font-size:11px;
}
.and-or-group button.ao-active{background:rgba(59,130,246,.15);color:#60a5fa}
.params-wrap{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;padding-left:20px}
.params-wrap label{color:var(--muted);font-size:10px;white-space:nowrap}
.params-wrap input{width:72px}
/* metrics strip */
.mstrip{display:none;flex-wrap:wrap;gap:10px;padding:10px 16px;border-top:1px solid var(--border)}
.mstrip.show{display:flex}
.mitem{display:flex;flex-direction:column;min-width:60px}
.mlabel{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.mval{font-size:13px;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace}
/* factor ranking */
.rank-row:hover td{background:rgba(59,130,246,.05)}
/* fbt */
.fbt-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:12px 16px;border-bottom:1px solid var(--border)}
.fbt-controls label{color:var(--muted);font-size:11px;white-space:nowrap}
.fbt-controls input{width:88px}
.caveat{
  padding:8px 12px;margin:12px 0;
  background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);
  border-radius:var(--radius);color:#fbbf24;font-size:11px;line-height:1.6;
}
/* portfolio rebalance */
.rb-hdr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;
  border-bottom:1px solid var(--border)}
.rb-section-hdr{padding:8px 12px 4px;font-size:10px;color:var(--muted);
  font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.rb-order-row,.rb-skip-row{font-size:11px;padding:3px 12px;
  border-bottom:1px solid rgba(255,255,255,.04)}
.rb-order-row{color:var(--muted)}
.rb-skip-row{color:#c8a820}
/* performance */
.perf-hdr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:12px 16px;border-bottom:1px solid var(--border)}
.perf-hdr label{color:var(--muted);font-size:11px}
/* settings */
.settings-row{margin-bottom:12px}
.settings-label{font-size:11px;color:var(--muted);display:block;margin-bottom:5px}
/* empty */
.empty{padding:20px;color:var(--muted);font-size:12px;text-align:center}
/* scrollbars */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.15)}
</style>
</head>
<body>

<aside id="sidebar">
  <div class="sb-logo">
    <div class="sb-logo-icon">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
    </div>
    <div>
      <div class="sb-logo-name">AutoTrade</div>
      <div class="sb-logo-sub">Toss Securities</div>
    </div>
  </div>
  <div class="sb-pills">
    <span class="pill pill-paper"><span class="pill-dot"></span>PAPER</span>
    <span class="pill pill-live">LIVE OFF</span>
  </div>
  <nav id="nav">
    <div class="nav-group-hdr">OVERVIEW</div>
    <button class="nav-item active" data-view="dashboard">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
      Dashboard
    </button>
    <div class="nav-group-hdr" style="margin-top:6px">RESEARCH</div>
    <button class="nav-item" data-view="lab">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v4l-2 4v8h12V11L16 7V3"/><path d="M8 3h8"/><path d="M6 15h12"/></svg>
      Strategy Lab
    </button>
    <button class="nav-item" data-view="composed">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      Composed
    </button>
    <button class="nav-item" data-view="ranking">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
      팩터 랭킹
    </button>
    <button class="nav-item" data-view="fbt">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      팩터 백테스트
    </button>
    <div class="nav-group-hdr" style="margin-top:6px">OPERATION</div>
    <button class="nav-item" data-view="trading">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
      Trading
    </button>
    <button class="nav-item" data-view="portfolio">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-4 0v2"/></svg>
      Portfolio
    </button>
    <button class="nav-item" data-view="orders">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
      Orders
    </button>
    <div class="nav-group-hdr" style="margin-top:6px">ANALYTICS</div>
    <button class="nav-item" data-view="performance">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Performance
    </button>
    <button class="nav-item" data-view="risk" id="nav-risk-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Risk / Halt
      <span class="nav-halt-dot" id="nav-halt-dot" style="display:none"></span>
    </button>
    <div class="nav-group-hdr" style="margin-top:6px"></div>
    <button class="nav-item" data-view="settings">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </button>
  </nav>
  <div class="sb-status">
    <div class="sb-status-row">
      <span class="sb-status-dot ok" id="sb-dot"></span>
      <span id="sb-status-text" style="font-size:10px;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--muted)">시스템 정상</span>
    </div>
    <div class="sb-clock" id="sb-clock"></div>
  </div>
</aside>

<div id="main">

  <div id="halt-banner">
    <div class="hb-full" id="hb-full">
      <div>
        <div class="hb-title">&#x26A1; SYSTEM HALTED &mdash; 모든 신규 주문이 차단됩니다</div>
        <div class="hb-sub" id="hb-reason"></div>
        <div id="hb-since" style="font-size:10px;margin-top:2px;color:rgba(255,255,255,.65);font-family:ui-monospace,SFMono-Regular,monospace"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <button class="btn" style="background:#fff;color:#dc2626;font-size:12px;font-weight:700;padding:5px 12px" id="hb-resume-btn">재개 &rarr;</button>
        <button id="hb-collapse-btn" style="background:none;border:0;color:rgba(255,255,255,.7);cursor:pointer;padding:4px;font-size:18px;line-height:1">&times;</button>
      </div>
    </div>
    <button class="hb-compact" id="hb-compact">&#x26A1; SYSTEM HALTED &mdash; 클릭하여 펼치기</button>
  </div>

  <header id="topbar">
    <span id="topbar-title">Dashboard</span>
    <div class="topbar-right">
      <div class="mkt-ticker" id="mkt-ticker">
        <div class="mkt-item"><span class="mkt-dot" style="background:var(--muted)"></span><span style="color:var(--muted)">시세 대기</span></div>
      </div>
      <div class="tb-div"></div>
      <button class="btn btn-danger" id="halt-btn" style="font-size:11px;padding:4px 10px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700">&#x23FB; HALT</button>
    </div>
  </header>

  <main id="content">

    <!-- ===== DASHBOARD ===== -->
    <section id="view-dashboard" class="view-section active">
      <div class="badge-row">
        <span class="badge badge-primary" id="dash-badge-paper">PAPER RUNNING</span>
        <span class="badge badge-muted" id="dash-badge-live">LIVE DISABLED</span>
        <span class="badge badge-bull" id="dash-badge-halt">HALT OFF</span>
        <span class="badge badge-bull" id="dash-badge-risk">RISK NORMAL</span>
      </div>
      <div class="metric-grid">
        <div class="metric-card">
          <div class="metric-label">보유 종목 수</div>
          <div class="metric-val neu" id="dash-pos-count">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">실행 전략 수</div>
          <div class="metric-val neu" id="dash-strat-count">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">미체결 주문</div>
          <div class="metric-val neu" id="dash-pending-count">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">총 실현손익</div>
          <div class="metric-val" id="dash-total-pnl">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">총수익률</div>
          <div class="metric-val" id="dash-return">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">MDD</div>
          <div class="metric-val neg" id="dash-mdd">&mdash;</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">승률</div>
          <div class="metric-val" id="dash-winrate">&mdash;</div>
        </div>
      </div>
      <div class="card">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">최근 포지션</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>종목</th><th class="num">수량</th><th class="num">실현손익</th></tr></thead>
            <tbody id="dash-pos-body"><tr><td colspan="3" class="empty">로딩 중…</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ===== STRATEGY LAB ===== -->
    <section id="view-lab" class="view-section">
      <div class="two-col">
        <div>
          <div class="card" style="margin-bottom:12px">
            <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">종목 선택</div>
            <div class="sym-search-wrap">
              <input type="search" id="lab-sym-search" placeholder="종목명 또는 코드…" autocomplete="off" spellcheck="false" style="width:100%">
            </div>
            <div class="sym-list-box" id="lab-sym-list"><div class="empty">검색 중…</div></div>
          </div>
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <span id="lab-chart-sym-label" style="font-size:12px;font-weight:600;color:var(--muted)">종목 미선택</span>
              <div class="int-tabs">
                <button class="int-btn active" data-iv="1d" data-ctx="lab">일봉</button>
                <button class="int-btn" data-iv="1m" data-ctx="lab">1분</button>
              </div>
            </div>
            <div class="chart-wrap">
              <div class="chart-div" id="lab-chart"></div>
              <div class="chart-hint" id="lab-chart-hint">종목을 선택하면 차트가 표시됩니다</div>
            </div>
            <div class="mstrip" id="lab-metrics">
              <div class="mitem"><span class="mlabel">수익률</span><span class="mval neu" id="m-ret"></span></div>
              <div class="mitem"><span class="mlabel">MDD</span><span class="mval neg" id="m-mdd"></span></div>
              <div class="mitem"><span class="mlabel">승률</span><span class="mval neu" id="m-wr"></span></div>
              <div class="mitem"><span class="mlabel">PF</span><span class="mval neu" id="m-pf"></span></div>
              <div class="mitem"><span class="mlabel">거래수</span><span class="mval neu" id="m-tc"></span></div>
            </div>
          </div>
        </div>
        <div class="card" style="display:flex;flex-direction:column;padding:0;overflow:hidden">
          <div class="bsec">
            <div class="bsec-title">전략 빌더</div>
            <div class="brow">
              <span class="blabel">A</span>
              <select id="type-a" style="flex:1">
                <option value="">전략 없음</option>
                <option value="tsmom">시계열 모멘텀(TSMOM)</option>
              </select>
            </div>
            <div id="params-a" class="params-wrap" style="display:none"></div>
            <div style="display:flex;justify-content:center;margin:8px 0">
              <div class="and-or-group">
                <button id="btn-and" class="ao-active" data-v="AND">AND</button>
                <button id="btn-or" data-v="OR">OR</button>
              </div>
            </div>
            <div class="brow">
              <span class="blabel">B</span>
              <select id="type-b" style="flex:1">
                <option value="">전략 없음</option>
                <option value="tsmom">시계열 모멘텀(TSMOM)</option>
              </select>
            </div>
            <div id="params-b" class="params-wrap" style="display:none"></div>
          </div>
          <div class="bsec">
            <div class="brow">
              <label for="notional" style="color:var(--muted);font-size:11px;white-space:nowrap">주문금액</label>
              <input type="number" id="notional" value="1000000" min="1" step="100000" style="flex:1">
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost" id="btn-backtest" disabled style="flex:1">백테스트</button>
              <button class="btn btn-success" id="btn-deploy" disabled style="flex:1">페이퍼 배포</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== COMPOSED STRATEGIES ===== -->
    <section id="view-composed" class="view-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-size:14px;font-weight:600">배포된 전략</span>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div id="strat-list-composed"><div class="empty">로딩 중…</div></div>
      </div>
    </section>

    <!-- ===== FACTOR RANKING ===== -->
    <section id="view-ranking" class="view-section">
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)">
          <span style="font-size:12px;font-weight:600">팩터 랭킹</span>
          <button class="btn btn-ghost" id="btn-rank-refresh" style="padding:3px 10px;font-size:11px">새로고침</button>
          <span id="rank-caption" style="font-size:10px;color:var(--muted);margin-left:4px"></span>
        </div>
        <div id="rank-status" class="empty" style="display:none"></div>
        <div class="tbl-wrap">
          <table id="rank-table" style="display:none">
            <thead>
              <tr>
                <th>순위</th><th>종목</th><th>섹터</th>
                <th class="num">Composite</th><th class="num">Momentum</th>
                <th class="num">Defensive</th><th class="num">Value</th><th class="num">Quality</th>
              </tr>
            </thead>
            <tbody id="rank-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ===== FACTOR BACKTEST ===== -->
    <section id="view-fbt" class="view-section">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="fbt-controls">
          <label for="fbt-topn">상위N</label>
          <input type="number" id="fbt-topn" value="5" min="1" step="1">
          <label for="fbt-rebal">거래일</label>
          <input type="number" id="fbt-rebal" value="21" min="1" step="1">
          <label for="fbt-cap">초기자본</label>
          <input type="number" id="fbt-cap" value="10000000" min="1" step="1000000">
          <button class="btn btn-ghost" id="btn-fbt-run">백테스트 실행</button>
        </div>
        <div id="fbt-status" style="display:none;padding:10px 16px;font-size:11px;color:var(--muted)"></div>
        <div id="fbt-chart-wrap" style="display:none;padding:0 0 0 0">
          <div class="chart-wrap-sm" style="margin:12px 16px">
            <div class="chart-div" id="fbt-chart"></div>
          </div>
        </div>
        <div id="fbt-metrics" style="display:none;flex-wrap:wrap;gap:10px;padding:10px 16px;border-top:1px solid var(--border)">
          <div class="mitem"><span class="mlabel">총수익률</span><span class="mval neu" id="fbt-m-ret"></span></div>
          <div class="mitem"><span class="mlabel">MDD</span><span class="mval neg" id="fbt-m-mdd"></span></div>
          <div class="mitem"><span class="mlabel">리밸런싱 횟수</span><span class="mval neu" id="fbt-m-rbc"></span></div>
          <div class="mitem"><span class="mlabel">최종자산</span><span class="mval neu" id="fbt-m-nav"></span></div>
        </div>
        <div class="caveat" style="margin:12px 16px">&#x26A0;&#xFE0F; 생존편향: 유니버스가 현재 상장 종목이라 과거 성과가 과대평가됨. MDD는 리밸런싱 경계에서만 샘플링되어 실제보다 작게 나옴. 참고용.</div>
        <div id="fbt-rebalances" style="display:none;padding:0 16px 8px"></div>
        <div id="fbt-caption" style="display:none;padding:4px 16px 10px;font-size:10px;color:var(--muted)"></div>
      </div>
    </section>

    <!-- ===== TRADING ===== -->
    <section id="view-trading" class="view-section">
      <div class="two-col">
        <div>
          <div class="card" style="margin-bottom:12px">
            <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">종목 검색</div>
            <div class="sym-search-wrap">
              <input type="search" id="trd-sym-search" placeholder="종목명 또는 코드…" autocomplete="off" spellcheck="false" style="width:100%">
            </div>
            <div class="sym-list-box" id="trd-sym-list"><div class="empty">검색 중…</div></div>
          </div>
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <span id="trd-chart-sym-label" style="font-size:12px;font-weight:600;color:var(--muted)">종목 미선택</span>
              <div class="int-tabs">
                <button class="int-btn active" data-iv="1d" data-ctx="trd">일봉</button>
                <button class="int-btn" data-iv="1m" data-ctx="trd">1분</button>
              </div>
            </div>
            <div class="chart-wrap">
              <div class="chart-div" id="trd-chart"></div>
              <div class="chart-hint" id="trd-chart-hint">종목을 선택하면 차트가 표시됩니다</div>
            </div>
          </div>
        </div>
        <div>
          <div class="card" style="margin-bottom:12px;padding:0;overflow:hidden">
            <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">포지션</div>
            <div class="tbl-wrap" style="max-height:240px;overflow-y:auto">
              <table>
                <thead><tr><th>종목</th><th class="num">수량</th><th class="num">실현손익</th></tr></thead>
                <tbody id="pos-body"></tbody>
              </table>
            </div>
          </div>
          <div class="card" style="padding:0;overflow:hidden">
            <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">로그</div>
            <div class="tbl-wrap" style="max-height:300px;overflow-y:auto">
              <table>
                <thead><tr><th>시각</th><th>유형</th><th>메시지</th></tr></thead>
                <tbody id="log-body"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== PORTFOLIO ===== -->
    <section id="view-portfolio" class="view-section">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="rb-hdr">
          <button class="btn btn-ghost" id="btn-rebalance">포트폴리오 리밸런싱 실행</button>
          <span style="font-size:10px;color:var(--muted)">(PAPER)</span>
          <label style="display:flex;align-items:center;gap:6px;margin-left:10px;cursor:pointer;user-select:none">
            <input type="checkbox" id="arb-toggle" style="cursor:pointer">
            <span style="font-size:11px;color:var(--fg)">자동 리밸런싱</span>
          </label>
          <span id="arb-caption" style="font-size:10px;color:var(--muted);margin-left:4px"></span>
        </div>
        <div class="caveat" style="margin:12px 16px 6px">페이퍼 전용 · 상위10 등가중 · 실행 시 시장가 주문</div>
        <div class="caveat" style="margin:6px 16px 12px">페이퍼 자동매매 · 거래일/정지 게이트 적용</div>
        <div id="rb-status" style="display:none;padding:10px 16px;font-size:11px;color:var(--bear)"></div>
        <div id="rb-plan" style="display:none">
          <div id="rb-summary" style="padding:8px 16px 4px;font-size:11px;color:var(--fg)"></div>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>종목</th><th class="num">목표수량</th><th class="num">현재</th><th class="num">&#916;</th><th class="num">가격</th></tr></thead>
              <tbody id="rb-targets-body"></tbody>
            </table>
          </div>
          <div id="rb-orders-section" style="display:none">
            <div class="rb-section-hdr">주문 제출</div>
            <div id="rb-orders-list"></div>
          </div>
          <div id="rb-skipped-section" style="display:none">
            <div class="rb-section-hdr">스킵</div>
            <div id="rb-skipped-list"></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;padding:0;overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">보유 포지션</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>종목</th><th class="num">수량</th><th class="num">실현손익</th></tr></thead>
            <tbody id="pf-pos-body"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ===== ORDERS ===== -->
    <section id="view-orders" class="view-section">
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">주문 내역</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>시각</th><th>종목</th><th>구분</th><th>유형</th><th class="num">수량</th><th>상태</th><th>전략</th></tr></thead>
            <tbody id="ord-body"><tr><td colspan="7" class="empty">로딩 중…</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ===== PERFORMANCE ===== -->
    <section id="view-performance" class="view-section">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="perf-hdr">
          <span style="font-size:12px;font-weight:600;margin-right:6px">성과</span>
          <label for="perf-strategy">전략</label>
          <select id="perf-strategy">
            <option value="1000">팩터 포트폴리오 (id=1000)</option>
          </select>
          <label for="perf-mode">모드</label>
          <select id="perf-mode">
            <option value="PAPER">PAPER</option>
            <option value="LIVE">LIVE</option>
          </select>
        </div>
        <div id="perf-status" style="display:none;padding:10px 16px;font-size:11px;color:var(--muted)"></div>
        <div id="perf-metrics" style="display:none;flex-wrap:wrap;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border)">
          <div class="mitem"><span class="mlabel">수익률</span><span class="mval neu" id="perf-m-ret"></span></div>
          <div class="mitem"><span class="mlabel">MDD</span><span class="mval neg" id="perf-m-mdd"></span></div>
          <div class="mitem"><span class="mlabel">승률</span><span class="mval neu" id="perf-m-wr"></span></div>
          <div class="mitem"><span class="mlabel">PF</span><span class="mval neu" id="perf-m-pf"></span></div>
          <div class="mitem"><span class="mlabel">거래수</span><span class="mval neu" id="perf-m-tc"></span></div>
          <div class="mitem"><span class="mlabel">평균손익비</span><span class="mval neu" id="perf-m-awl"></span></div>
        </div>
        <div id="perf-chart-wrap" style="display:none">
          <div class="chart-wrap-sm" style="margin:12px 16px">
            <div class="chart-div" id="perf-chart"></div>
          </div>
        </div>
        <div id="perf-empty" style="display:none;padding:16px;font-size:11px;color:var(--muted)">스냅샷 없음 (운용 중 누적)</div>
      </div>
    </section>

    <!-- ===== RISK / HALT ===== -->
    <section id="view-risk" class="view-section">
      <div class="card">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">Global Halt</div>
        <div class="row-flex" style="margin-bottom:14px">
          <span class="badge badge-bull" id="risk-halt-badge">HALT OFF</span>
          <span id="risk-halt-reason" style="font-size:12px;color:var(--muted)"></span>
        </div>
        <button class="btn btn-danger" id="stop-btn">긴급 정지</button>
        <div style="margin-top:12px;font-size:11px;color:var(--muted)">긴급 정지 시 모든 신규 주문이 즉시 차단됩니다. 재개는 수동 승인입니다.</div>
      </div>
    </section>

    <!-- ===== SETTINGS ===== -->
    <section id="view-settings" class="view-section">
      <div class="card" style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">시스템</div>
        <div class="settings-row">
          <span class="settings-label">모드</span>
          <span class="badge badge-primary">PAPER</span>
          <span class="badge badge-muted" style="margin-left:6px">LIVE DISABLED</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Toss API</span>
          <span style="font-size:12px;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--fg)">https://*.tossinvest.com (마스킹됨)</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">상태 파일 / Halt 파일</span>
          <span style="font-size:12px;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--fg)">trading-state.json &middot; halt-state.json</span>
        </div>
      </div>
      <div class="card">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">API_TOKEN</div>
        <div class="settings-row">
          <span class="settings-label">뮤테이션 요청에 사용할 x-api-token (localStorage에 저장)</span>
          <div class="row-flex">
            <input type="password" id="api-token-input" placeholder="API_TOKEN" autocomplete="off" style="width:260px">
            <button class="btn btn-primary" id="api-token-save">저장</button>
            <span id="api-token-status" style="font-size:11px;color:var(--muted)"></span>
          </div>
        </div>
      </div>
    </section>

  </main>
</div>

<script>
/* ---- Utilities ---- */
var $ = function(s) { return document.querySelector(s); };
var jfetch = function(u) { return fetch(u).then(function(r) { return r.json(); }); };
// Escape ALL interpolated values — feed-derived strings (symbols, names, log messages) would
// otherwise be a stored-XSS sink when inserted via innerHTML.
var esc = function(s) { return String(s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
var cell = function(v, cls) { return '<td' + (cls ? ' class="' + esc(cls) + '"' : '') + '>' + esc(v == null ? '' : v) + '</td>'; };
var numCls = function(n) { return Number(n) > 0 ? 'num pos' : Number(n) < 0 ? 'num neg' : 'num'; };
var pct = function(v) { return (Number(v) * 100).toFixed(2) + '%'; };
var token = function() { return localStorage.getItem('apiToken') || ''; };

/* ---- View router ---- */
var VIEW_TITLES = {
  dashboard: 'Dashboard', lab: 'Strategy Lab', composed: 'Composed',
  ranking: '팩터 랭킹', fbt: '팩터 백테스트', trading: 'Trading',
  portfolio: 'Portfolio', orders: 'Orders', performance: 'Performance',
  risk: 'Risk / Halt', settings: 'Settings'
};
var currentView = 'dashboard';
function navigate(view) {
  if (!VIEW_TITLES[view]) return;
  currentView = view;
  document.querySelectorAll('.view-section').forEach(function(sec) {
    sec.classList.toggle('active', sec.id === 'view-' + view);
  });
  document.querySelectorAll('.nav-item').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  var titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = VIEW_TITLES[view];
  if (view === 'ranking' && !rankLoaded && !rankLoading) loadRanking();
  if (view === 'portfolio') loadAutoRebalanceStatus();
  if (view === 'performance') loadPerfData();
  if (view === 'dashboard') loadDashPerf();
  if (view === 'lab' && labChart) labChart.applyOptions({ width: document.getElementById('lab-chart').offsetWidth });
  if (view === 'trading' && trdChart) trdChart.applyOptions({ width: document.getElementById('trd-chart').offsetWidth });
}
document.querySelectorAll('.nav-item').forEach(function(btn) {
  btn.addEventListener('click', function() { navigate(this.dataset.view); });
});

/* ---- Sidebar clock ---- */
function tickClock() {
  var el = document.getElementById('sb-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

/* ---- State ---- */
var activeSymbol = null;
var intervals = { lab: '1d', trd: '1d' };
var combine = 'AND';
var isHalted = false;
var haltBannerExpanded = true;

/* ---- Chart factory (hardened: errors are isolated — rest of the page must still work) ---- */
function normTime(t) {
  var n = Number(t);
  return n > 1e10 ? Math.floor(n / 1000) : n;
}
function makeCandleChart(el) {
  var c = LightweightCharts.createChart(el, {
    layout: { background: { color: '#0a0f1e' }, textColor: '#94a3b8' },
    grid: { vertLines: { color: '#16213a' }, horzLines: { color: '#16213a' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true },
    width: el.offsetWidth || 600,
    height: el.offsetHeight || 280,
  });
  var s = c.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    borderVisible: false,
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
  });
  new ResizeObserver(function() {
    c.applyOptions({ width: el.offsetWidth, height: el.offsetHeight });
  }).observe(el);
  return { chart: c, series: s };
}

var labChart = null, labSeries = null;
try {
  var labEl = document.getElementById('lab-chart');
  var labMade = makeCandleChart(labEl);
  labChart = labMade.chart; labSeries = labMade.series;
} catch (labChartErr) {
  console.error('[lab-chart] init failed:', labChartErr);
  var labHint = document.getElementById('lab-chart-hint');
  if (labHint) { labHint.textContent = 'chart unavailable'; labHint.style.color = '#ef4444'; }
}
var trdChart = null, trdSeries = null;
try {
  var trdEl = document.getElementById('trd-chart');
  var trdMade = makeCandleChart(trdEl);
  trdChart = trdMade.chart; trdSeries = trdMade.series;
} catch (trdChartErr) {
  console.error('[trd-chart] init failed:', trdChartErr);
  var trdHint = document.getElementById('trd-chart-hint');
  if (trdHint) { trdHint.textContent = 'chart unavailable'; trdHint.style.color = '#ef4444'; }
}
function seriesFor(ctx) { return ctx === 'trd' ? trdSeries : labSeries; }
function chartFor(ctx) { return ctx === 'trd' ? trdChart : labChart; }

/* ---- Interval toggle (per context) ---- */
document.querySelectorAll('.int-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var ctx = this.dataset.ctx;
    intervals[ctx] = this.dataset.iv;
    document.querySelectorAll('.int-btn[data-ctx="' + ctx + '"]').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    if (activeSymbol) loadCandles(activeSymbol, ctx);
  });
});

/* ---- Candles ---- */
function loadCandles(sym, ctx) {
  var hint = document.getElementById(ctx + '-chart-hint');
  if (hint) hint.style.display = 'none';
  jfetch('/api/market/candles?symbol=' + encodeURIComponent(sym) + '&interval=' + intervals[ctx]).then(function(candles) {
    var series = seriesFor(ctx);
    if (!series || !Array.isArray(candles)) return;
    // Sort ascending; dedup by time — lightweight-charts throws on duplicate timestamps
    var seen = {};
    var data = candles.slice().sort(function(a, b) { return a.time - b.time; }).filter(function(c) {
      if (seen[c.time]) return false;
      seen[c.time] = true;
      return true;
    }).map(function(c) {
      return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    });
    series.setData(data);
    if (series.setMarkers) series.setMarkers([]);
    var chart = chartFor(ctx);
    if (chart) chart.timeScale().fitContent();
  }).catch(function() {});
}

/* ---- Symbol search (debounced, dual context: lab + trd) ---- */
function selectSymbol(sym) {
  activeSymbol = sym;
  document.querySelectorAll('.sym-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.sym === sym);
  });
  ['lab', 'trd'].forEach(function(ctx) {
    var lblEl = document.getElementById(ctx + '-chart-sym-label');
    if (lblEl) { lblEl.textContent = sym; lblEl.style.color = '#e5e7eb'; }
    loadCandles(sym, ctx);
  });
  updateButtons();
}
function renderSymList(listEl, list, q) {
  if (!Array.isArray(list) || !list.length) {
    listEl.innerHTML = '<div class="empty">' + (q ? '결과 없음' : '검색 중…') + '</div>';
    return;
  }
  listEl.innerHTML = list.map(function(s) {
    var active = activeSymbol === s.symbol ? ' active' : '';
    return '<div class="sym-item' + active + '" data-sym="' + esc(s.symbol) + '">' +
      '<div class="sym-name">' + esc(s.name) + '</div>' +
      '<div class="sym-code">' + esc(s.symbol) + '<span class="sym-tag">' + esc(s.market) + '</span></div>' +
    '</div>';
  }).join('');
  listEl.querySelectorAll('.sym-item').forEach(function(item) {
    item.addEventListener('click', function() { selectSymbol(this.dataset.sym); });
  });
}
function searchSymbols(q) {
  jfetch('/api/market/symbols?q=' + encodeURIComponent(q) + '&limit=40').then(function(list) {
    var labList = document.getElementById('lab-sym-list');
    var trdList = document.getElementById('trd-sym-list');
    if (labList) renderSymList(labList, list, q);
    if (trdList) renderSymList(trdList, list, q);
  }).catch(function() {});
}
var searchTimer = null;
['lab-sym-search', 'trd-sym-search'].forEach(function(id) {
  var input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('input', function() {
    clearTimeout(searchTimer);
    var q = this.value.trim();
    searchTimer = setTimeout(function() { searchSymbols(q); }, 300);
  });
});
searchSymbols('');

/* ---- Strategy builder ---- */
function paramFields(type, prefix) {
  if (type === 'tsmom') {
    return '<label>룩백</label><input type="number" id="' + prefix + '-lookback" value="20" min="1" step="1">' +
           '<label>임계%</label><input type="number" id="' + prefix + '-thresh" value="0" min="0" step="0.1">';
  }
  return '';
}
function onTypeChange(prefix) {
  var sel = $('#type-' + prefix);
  var pEl = $('#params-' + prefix);
  var type = sel.value;
  if (type) {
    pEl.innerHTML = paramFields(type, prefix);
    pEl.style.display = 'flex';
  } else {
    pEl.innerHTML = '';
    pEl.style.display = 'none';
  }
  updateButtons();
}
$('#type-a').addEventListener('change', function() { onTypeChange('a'); });
$('#type-b').addEventListener('change', function() { onTypeChange('b'); });

/* AND / OR toggle */
document.querySelectorAll('.and-or-group button').forEach(function(btn) {
  btn.addEventListener('click', function() {
    combine = this.dataset.v;
    document.querySelectorAll('.and-or-group button').forEach(function(b) {
      b.classList.toggle('ao-active', b.dataset.v === combine);
    });
  });
});

function updateButtons() {
  var hasA = !!$('#type-a').value;
  var hasB = !!$('#type-b').value;
  var ok = (hasA || hasB) && !!activeSymbol;
  $('#btn-backtest').disabled = !ok;
  $('#btn-deploy').disabled = !ok;
}
function getNum(id, fallback) {
  var v = Number($(id).value);
  return isFinite(v) && v > 0 ? v : fallback;
}
function buildSingleSpec(type, prefix, notional) {
  if (type === 'tsmom') {
    var lookback = Math.max(1, Math.round(getNum('#' + prefix + '-lookback', 20)));
    var threshPct = Number($('#' + prefix + '-thresh').value);
    var thresh = isFinite(threshPct) && threshPct >= 0 ? threshPct / 100 : 0;
    return { type: 'tsmom', params: { lookback: lookback, threshold: thresh, orderNotional: notional } };
  }
  return null;
}
function buildSpec() {
  var notional = getNum('#notional', 1000000);
  var typeA = $('#type-a').value;
  var typeB = $('#type-b').value;
  if (typeA && typeB) {
    return { type: 'composite', combine: combine, a: buildSingleSpec(typeA, 'a', notional), b: buildSingleSpec(typeB, 'b', notional), orderNotional: notional };
  }
  if (typeA) return buildSingleSpec(typeA, 'a', notional);
  if (typeB) return buildSingleSpec(typeB, 'b', notional);
  return null;
}

/* ---- 백테스트 ---- */
$('#btn-backtest').addEventListener('click', function() {
  if (!activeSymbol) { alert('종목을 먼저 선택하세요.'); return; }
  var spec = buildSpec();
  if (!spec) { alert('전략을 하나 이상 설정하세요.'); return; }
  fetch('/api/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: activeSymbol, spec: spec }),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(rd) {
    if (!rd.ok) { alert(esc(rd.d.error || '오류')); return; }
    var data = rd.d;
    if (labSeries) {
      // Draw BUY / SELL markers
      var markers = (data.markers || []).map(function(m) {
        return {
          time: normTime(m.time),
          position: m.side === 'BUY' ? 'belowBar' : 'aboveBar',
          color: m.side === 'BUY' ? '#22c55e' : '#ef4444',
          shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: m.side,
        };
      }).sort(function(a, b) { return a.time - b.time; });
      labSeries.setMarkers(markers);
    }
    // Show metrics
    var m = data.metrics || {};
    var ret = Number(m.totalReturn) || 0;
    var mdd = Number(m.maxDrawdown) || 0;
    var wr = Number(m.winRate) || 0;
    var pf = Number(m.profitFactor) || 0;
    var tc = Number(m.tradeCount) || 0;
    $('#m-ret').textContent = pct(ret);
    $('#m-ret').className = 'mval ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu');
    $('#m-mdd').textContent = pct(mdd);
    $('#m-mdd').className = 'mval neg';
    $('#m-wr').textContent = pct(wr);
    $('#m-wr').className = 'mval ' + (wr >= 0.5 ? 'pos' : 'neg');
    $('#m-pf').textContent = pf.toFixed(2);
    $('#m-pf').className = 'mval ' + (pf >= 1 ? 'pos' : 'neg');
    $('#m-tc').textContent = String(tc);
    $('#m-tc').className = 'mval neu';
    $('#lab-metrics').classList.add('show');
  }).catch(function() {});
});

/* ---- 페이퍼 배포 ---- */
$('#btn-deploy').addEventListener('click', function() {
  if (!activeSymbol) { alert('종목을 먼저 선택하세요.'); return; }
  var spec = buildSpec();
  if (!spec) { alert('전략을 하나 이상 설정하세요.'); return; }
  var typeA = $('#type-a').value;
  var typeB = $('#type-b').value;
  var suffix = typeA && typeB ? combine.toLowerCase() : (typeA || typeB);
  var name = activeSymbol + '-' + suffix;
  fetch('/api/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token() },
    body: JSON.stringify({ symbol: activeSymbol, spec: spec, name: name }),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(rd) {
    if (!rd.ok) { alert(esc(rd.d.error || '배포 실패')); return; }
    refreshStrategies();
  }).catch(function() {});
});

/* ---- 긴급 정지 / 재개 ---- */
function doEmergencyStop() {
  if (!confirm('모든 신규 주문을 즉시 차단합니다. 계속?')) return;
  fetch('/api/emergency-stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token() },
    body: JSON.stringify({ reason: 'dashboard' }),
  }).then(function() { refreshAll(); }).catch(function() {});
}
function doResume() {
  fetch('/api/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token() },
    body: JSON.stringify({}),
  }).then(function() { refreshAll(); }).catch(function() {});
}
var stopBtn = document.getElementById('stop-btn');
if (stopBtn) {
  stopBtn.addEventListener('click', function() {
    if (isHalted) doResume(); else doEmergencyStop();
  });
}
var haltBtn = document.getElementById('halt-btn');
if (haltBtn) {
  haltBtn.addEventListener('click', function() {
    if (isHalted) { navigate('risk'); return; }
    doEmergencyStop();
  });
}
var hbResumeBtn = document.getElementById('hb-resume-btn');
if (hbResumeBtn) {
  hbResumeBtn.addEventListener('click', function() { navigate('risk'); });
}
var hbCollapseBtn = document.getElementById('hb-collapse-btn');
if (hbCollapseBtn) {
  hbCollapseBtn.addEventListener('click', function() {
    haltBannerExpanded = false;
    applyHaltBanner();
  });
}
var hbCompactBtn = document.getElementById('hb-compact');
if (hbCompactBtn) {
  hbCompactBtn.addEventListener('click', function() {
    haltBannerExpanded = true;
    applyHaltBanner();
  });
}
var lastHaltReason = '';
function applyHaltBanner() {
  var banner = document.getElementById('halt-banner');
  var full = document.getElementById('hb-full');
  var compact = document.getElementById('hb-compact');
  if (!banner || !full || !compact) return;
  if (!isHalted) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  full.style.display = haltBannerExpanded ? 'flex' : 'none';
  compact.style.display = haltBannerExpanded ? 'none' : 'flex';
}

/* ---- Data refresh (cheap endpoints only — polled every 3s) ---- */
function refreshHalt() {
  jfetch('/api/halt').then(function(halt) {
    isHalted = !!halt.halted;
    lastHaltReason = halt.reason || '';
    /* halt banner */
    var reasonEl = document.getElementById('hb-reason');
    if (reasonEl) reasonEl.textContent = lastHaltReason ? 'Reason: ' + lastHaltReason : '';
    var sinceEl = document.getElementById('hb-since');
    if (sinceEl) sinceEl.textContent = isHalted ? 'New orders are blocked.' : '';
    applyHaltBanner();
    /* topbar */
    var hBtn = document.getElementById('halt-btn');
    if (hBtn) {
      hBtn.innerHTML = isHalted ? '&#x23FB; HALTED' : '&#x23FB; HALT';
      hBtn.style.animation = isHalted ? 'sbpulse 1s infinite' : '';
    }
    /* sidebar */
    var dot = document.getElementById('sb-dot');
    if (dot) dot.className = 'sb-status-dot ' + (isHalted ? 'halt' : 'ok');
    var st = document.getElementById('sb-status-text');
    if (st) st.textContent = isHalted ? 'HALTED' : '시스템 정상';
    var navDot = document.getElementById('nav-halt-dot');
    if (navDot) navDot.style.display = isHalted ? '' : 'none';
    /* dashboard badges */
    var haltBadge = document.getElementById('dash-badge-halt');
    if (haltBadge) {
      haltBadge.textContent = isHalted ? 'HALT ON' : 'HALT OFF';
      haltBadge.className = 'badge ' + (isHalted ? 'badge-bear' : 'badge-bull');
    }
    var riskBadge = document.getElementById('dash-badge-risk');
    if (riskBadge) {
      riskBadge.textContent = isHalted ? 'RISK HALTED' : 'RISK NORMAL';
      riskBadge.className = 'badge ' + (isHalted ? 'badge-bear' : 'badge-bull');
    }
    /* risk view */
    var rBadge = document.getElementById('risk-halt-badge');
    if (rBadge) {
      rBadge.textContent = isHalted ? 'HALT ON' : 'HALT OFF';
      rBadge.className = 'badge ' + (isHalted ? 'badge-bear' : 'badge-bull');
    }
    var rReason = document.getElementById('risk-halt-reason');
    if (rReason) rReason.textContent = isHalted && lastHaltReason ? '사유: ' + lastHaltReason : '';
    var sBtn = document.getElementById('stop-btn');
    if (sBtn) {
      sBtn.textContent = isHalted ? '재개' : '긴급 정지';
      sBtn.className = 'btn ' + (isHalted ? 'btn-success' : 'btn-danger');
    }
  }).catch(function() {});
}

function refreshStrategies() {
  jfetch('/api/strategies').then(function(strats) {
    var cnt = document.getElementById('dash-strat-count');
    if (cnt) cnt.textContent = Array.isArray(strats) ? String(strats.length) : '—';
    var el = document.getElementById('strat-list-composed');
    if (!el) return;
    if (!Array.isArray(strats) || !strats.length) {
      el.innerHTML = '<div class="empty">배포된 전략 없음</div>';
      return;
    }
    el.innerHTML = strats.map(function(s) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04)">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(s.name) + '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px;font-family:ui-monospace,SFMono-Regular,monospace">' + esc(s.status) + ' · ' + esc((s.symbols || []).join(', ')) + '</div>' +
        '</div>' +
        '<span class="badge badge-primary" style="font-size:9px">' + esc(s.status) + '</span>' +
        '<button class="sitem-del btn btn-danger" data-id="' + esc(s.id) + '" style="padding:2px 8px;font-size:11px">✕</button>' +
      '</div>';
    }).join('');
    el.querySelectorAll('.sitem-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = encodeURIComponent(this.dataset.id);
        fetch('/api/strategies/' + id, { method: 'DELETE', headers: { 'x-api-token': token() } })
          .then(function() { refreshStrategies(); }).catch(function() {});
      });
    });
  }).catch(function() {});
}

function refreshPositions() {
  jfetch('/api/positions').then(function(pos) {
    if (!Array.isArray(pos)) return;
    var rows = pos.map(function(p) {
      return '<tr>' + cell(p.symbol) + cell(p.quantity, 'num') + cell(p.realizedPnl, numCls(p.realizedPnl)) + '</tr>';
    }).join('');
    var emptyRow = '<tr><td colspan="3" class="empty">포지션 없음</td></tr>';
    ['pos-body', 'pf-pos-body', 'dash-pos-body'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = rows || emptyRow;
    });
    var held = pos.filter(function(p) { return Number(p.quantity) !== 0; });
    var cnt = document.getElementById('dash-pos-count');
    if (cnt) cnt.textContent = String(held.length);
    var totalPnl = 0;
    pos.forEach(function(p) { totalPnl += Number(p.realizedPnl) || 0; });
    var pnlEl = document.getElementById('dash-total-pnl');
    if (pnlEl) {
      pnlEl.textContent = Math.round(totalPnl).toLocaleString();
      pnlEl.className = 'metric-val ' + (totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : 'neu');
    }
  }).catch(function() {});
}

function refreshLogs() {
  jfetch('/api/logs?limit=20').then(function(logs) {
    if (!Array.isArray(logs)) return;
    var el = document.getElementById('log-body');
    if (el) el.innerHTML = logs.slice().reverse().map(function(l) {
      return '<tr>' + cell(new Date(l.at).toLocaleTimeString()) + cell(l.type) + cell(l.message || '') + '</tr>';
    }).join('');
  }).catch(function() {});
}

function refreshOrders() {
  jfetch('/api/orders').then(function(orders) {
    if (!Array.isArray(orders)) return;
    var pending = 0;
    orders.forEach(function(o) {
      if (o.status !== 'FILLED' && o.status !== 'CANCELLED' && o.status !== 'CANCELED' && o.status !== 'REJECTED') pending++;
    });
    var pEl = document.getElementById('dash-pending-count');
    if (pEl) pEl.textContent = String(pending);
    var el = document.getElementById('ord-body');
    if (!el) return;
    if (!orders.length) {
      el.innerHTML = '<tr><td colspan="7" class="empty">주문 없음</td></tr>';
      return;
    }
    el.innerHTML = orders.slice().reverse().slice(0, 100).map(function(o) {
      var sideCls = o.side === 'BUY' ? 'pos' : 'neg';
      return '<tr>' +
        cell(o.createdAt ? new Date(o.createdAt).toLocaleTimeString() : '') +
        cell(o.symbol) +
        '<td class="' + sideCls + '">' + esc(o.side || '') + '</td>' +
        cell(o.orderType) +
        cell(o.quantity, 'num') +
        cell(o.status) +
        cell(o.strategyId != null ? o.strategyId : '') +
      '</tr>';
    }).join('');
  }).catch(function() {});
}

// Topbar ticker: live quotes for the seeded symbols from the in-memory QuoteBook (cheap).
var TICKER_SYMBOLS = [{ sym: '005930', label: '삼성전자' }, { sym: '000660', label: 'SK하이닉스' }];
function refreshTicker() {
  jfetch('/api/market/prices?symbols=' + TICKER_SYMBOLS.map(function(t) { return t.sym; }).join(',')).then(function(quotes) {
    var el = document.getElementById('mkt-ticker');
    if (!el) return;
    var bySym = {};
    (quotes || []).forEach(function(q) { if (q && q.symbol) bySym[q.symbol] = q; });
    var html = '';
    TICKER_SYMBOLS.forEach(function(t) {
      var q = bySym[t.sym];
      if (!q || q.last == null) return;
      html += '<div class="mkt-item"><span class="mkt-dot" style="background:var(--bull)"></span>'
        + '<span style="color:var(--muted)">' + esc(t.label) + '</span>'
        + '<span style="font-weight:600">' + esc(Number(q.last).toLocaleString()) + '</span></div>';
    });
    el.innerHTML = html || '<div class="mkt-item"><span class="mkt-dot" style="background:var(--muted)"></span><span style="color:var(--muted)">시세 대기 (장 마감)</span></div>';
  }).catch(function() {});
}
function refreshAll() {
  refreshHalt();
  refreshStrategies();
  refreshPositions();
  refreshLogs();
  refreshOrders();
  refreshTicker();
}
refreshAll();
setInterval(refreshAll, 3000);

/* ---- Dashboard performance metrics (fetch on view open only — NOT in 3s poll) ---- */
function loadDashPerf() {
  fetch('/api/performance?strategyId=1000&mode=PAPER', { headers: { 'x-api-token': token() } })
    .then(function(r) { if (!r.ok) return null; return r.json(); })
    .then(function(data) {
      if (!data || !data.metrics) return;
      var m = data.metrics;
      var ret = Number(m.totalReturn) || 0;
      var mdd = Number(m.maxDrawdown) || 0;
      var wr = Number(m.winRate) || 0;
      var retEl = document.getElementById('dash-return');
      if (retEl) {
        retEl.textContent = pct(ret);
        retEl.className = 'metric-val ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu');
      }
      var mddEl = document.getElementById('dash-mdd');
      if (mddEl) mddEl.textContent = pct(mdd);
      var wrEl = document.getElementById('dash-winrate');
      if (wrEl) {
        wrEl.textContent = (wr * 100).toFixed(1) + '%';
        wrEl.className = 'metric-val ' + (wr >= 0.5 ? 'pos' : 'neu');
      }
    }).catch(function() {});
}
loadDashPerf();

/* ---- Factor Ranking (load on view-open + manual refresh; NOT in the 3s auto-poll) ---- */
var rankLoaded = false;
var rankLoading = false;

function renderRanking(data) {
  var status = document.getElementById('rank-status');
  var table = document.getElementById('rank-table');
  var tbody = document.getElementById('rank-tbody');
  var caption = document.getElementById('rank-caption');
  if (!data || !Array.isArray(data.scored) || !data.scored.length) {
    status.textContent = '랭킹 데이터 없음';
    status.style.display = '';
    table.style.display = 'none';
    return;
  }
  var asOfDate = new Date(data.asOf);
  caption.textContent = 'asOf ' + asOfDate.toLocaleTimeString() + ' · universe ' + data.universeSize + ' · fetched ' + data.fetched;
  tbody.innerHTML = data.scored.map(function(row) {
    var composite = Number(row.composite);
    var compositeStr = isFinite(composite) ? composite.toFixed(3) : '-';
    var compositeColor = composite >= 0 ? 'pos' : 'neg';
    var momentum = (row.factors && row.factors.momentum != null) ? Number(row.factors.momentum).toFixed(2) : '';
    var defensive = (row.factors && row.factors.defensive != null) ? Number(row.factors.defensive).toFixed(2) : '';
    var value = (row.factors && row.factors.value != null) ? Number(row.factors.value).toFixed(2) : '';
    var quality = (row.factors && row.factors.quality != null) ? Number(row.factors.quality).toFixed(2) : '';
    return '<tr class="rank-row" data-sym="' + esc(row.symbol) + '" style="cursor:pointer">' +
      '<td class="num">' + esc(String(row.rank)) + '</td>' +
      '<td>' + esc(row.symbol) + '</td>' +
      '<td>' + esc(row.sector || '') + '</td>' +
      '<td class="num ' + compositeColor + '">' + esc(compositeStr) + '</td>' +
      '<td class="num">' + esc(momentum) + '</td>' +
      '<td class="num">' + esc(defensive) + '</td>' +
      '<td class="num">' + esc(value) + '</td>' +
      '<td class="num">' + esc(quality) + '</td>' +
    '</tr>';
  }).join('');
  table.querySelectorAll('.rank-row').forEach(function(tr) {
    tr.addEventListener('click', function() {
      selectSymbol(this.dataset.sym);
      navigate('lab');
    });
  });
  status.style.display = 'none';
  table.style.display = '';
}

function loadRanking() {
  if (rankLoading) return;
  rankLoading = true;
  rankLoaded = false;
  var status = document.getElementById('rank-status');
  var table = document.getElementById('rank-table');
  var caption = document.getElementById('rank-caption');
  status.textContent = '랭킹 계산 중… (최초 최대 40초)';
  status.style.display = '';
  table.style.display = 'none';
  caption.textContent = '';
  fetch('/api/factors/ranking?limit=20').then(function(r) {
    if (r.status === 503) {
      return r.json().then(function() {
        status.textContent = '팩터 랭킹 비활성';
        status.style.display = '';
        table.style.display = 'none';
        rankLoading = false;
      });
    }
    if (!r.ok) {
      return r.json().then(function(d) {
        status.textContent = '오류: ' + (d.error || '알 수 없음');
        status.style.display = '';
        table.style.display = 'none';
        rankLoading = false;
      });
    }
    return r.json().then(function(data) {
      rankLoading = false;
      rankLoaded = true;
      renderRanking(data);
    });
  }).catch(function() {
    rankLoading = false;
    var s = document.getElementById('rank-status');
    var t = document.getElementById('rank-table');
    if (s) { s.textContent = '네트워크 오류'; s.style.display = ''; }
    if (t) t.style.display = 'none';
  });
}
var rankRefreshBtn = document.getElementById('btn-rank-refresh');
if (rankRefreshBtn) {
  rankRefreshBtn.addEventListener('click', function() { loadRanking(); });
}

/* ---- Factor Backtest (run on button click only — NOT in 3s loop) ---- */
var fbtChart = null;
var fbtSeries = null;

function ensureAreaChart(el, lineColor, topColor, bottomColor) {
  var c = LightweightCharts.createChart(el, {
    layout: { background: { color: '#0a0f1e' }, textColor: '#94a3b8' },
    grid: { vertLines: { color: '#16213a' }, horzLines: { color: '#16213a' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true },
    width: el.offsetWidth || 600,
    height: el.offsetHeight || 200,
    handleScroll: false,
    handleScale: false,
  });
  var s = c.addAreaSeries({
    lineColor: lineColor,
    topColor: topColor,
    bottomColor: bottomColor,
    lineWidth: 2,
  });
  new ResizeObserver(function() {
    c.applyOptions({ width: el.offsetWidth, height: el.offsetHeight });
  }).observe(el);
  return { chart: c, series: s };
}

function ensureFbtChart(el) {
  if (fbtChart) return true;
  try {
    var made = ensureAreaChart(el, '#22c55e', 'rgba(34,197,94,0.25)', 'rgba(34,197,94,0.02)');
    fbtChart = made.chart;
    fbtSeries = made.series;
    return true;
  } catch (e) {
    console.error('[fbt-chart] init failed:', e);
    fbtChart = null;
    fbtSeries = null;
    return false;
  }
}

function renderFactorBacktest(data) {
  var result = data.result || {};
  var metrics = result.metrics || {};
  var equityCurve = result.equityCurve || [];
  var rebalances = result.rebalances || [];

  /* equity curve chart */
  var chartWrap = document.getElementById('fbt-chart-wrap');
  var fbtChartEl = document.getElementById('fbt-chart');
  try {
    if (equityCurve.length && fbtChartEl) {
      if (chartWrap) chartWrap.style.display = '';
      if (ensureFbtChart(fbtChartEl)) {
        var seen2 = {};
        var curveData = equityCurve.map(function(p) {
          return { time: Math.floor(p.date / 1000), value: p.nav };
        }).sort(function(a, b) { return a.time - b.time; }).filter(function(p) {
          if (seen2[p.time]) return false;
          seen2[p.time] = true;
          return true;
        });
        if (fbtSeries) fbtSeries.setData(curveData);
        if (fbtChart) {
          fbtChart.applyOptions({ width: fbtChartEl.offsetWidth, height: fbtChartEl.offsetHeight });
          fbtChart.timeScale().fitContent();
        }
      }
    }
  } catch (chartErr) {
    console.error('[fbt-chart] render failed:', chartErr);
  }

  /* metrics */
  var ret = Number(metrics.totalReturn) || 0;
  var mdd = Number(metrics.maxDrawdown) || 0;
  var rbc = Number(metrics.rebalanceCount) || 0;
  var fnav = Number(metrics.finalNav) || 0;
  var mRetEl = document.getElementById('fbt-m-ret');
  var mMddEl = document.getElementById('fbt-m-mdd');
  var mRbcEl = document.getElementById('fbt-m-rbc');
  var mNavEl = document.getElementById('fbt-m-nav');
  var fbtMetrics = document.getElementById('fbt-metrics');
  if (mRetEl) { mRetEl.textContent = (ret * 100).toFixed(2) + '%'; mRetEl.className = 'mval ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu'); }
  if (mMddEl) { mMddEl.textContent = (mdd * 100).toFixed(2) + '%'; mMddEl.className = 'mval neg'; }
  if (mRbcEl) { mRbcEl.textContent = String(rbc); mRbcEl.className = 'mval neu'; }
  if (mNavEl) { mNavEl.textContent = Math.round(fnav).toLocaleString(); mNavEl.className = 'mval neu'; }
  if (fbtMetrics) fbtMetrics.style.display = 'flex';

  /* rebalances (most recent 15) */
  var rebalEl = document.getElementById('fbt-rebalances');
  var recent = rebalances.slice(-15);
  if (rebalEl && recent.length) {
    rebalEl.innerHTML = recent.map(function(rb) {
      var d = new Date(rb.date);
      var mo = d.getMonth() + 1;
      var dy = d.getDate();
      var ds = d.getFullYear() + '-' + (mo < 10 ? '0' : '') + String(mo) + '-' + (dy < 10 ? '0' : '') + String(dy);
      var holdings = Array.isArray(rb.holdings) ? rb.holdings.join(', ') : '';
      return '<div style="font-size:10px;color:var(--muted);padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#60a5fa;display:inline-block;min-width:82px;font-family:ui-monospace,SFMono-Regular,monospace">' + esc(ds) + '</span> ' + esc(holdings) + '</div>';
    }).join('');
    rebalEl.style.display = '';
  }

  /* caption */
  var captionEl = document.getElementById('fbt-caption');
  if (captionEl) {
    var asOfD = new Date(data.asOf);
    captionEl.textContent = 'universe ' + String(data.universeSize || 0) + ' / fetched ' + String(data.fetched || 0) + ' / skipped ' + String(data.skipped || 0) + ' · asOf ' + asOfD.toLocaleString();
    captionEl.style.display = '';
  }
}

function runFactorBacktest() {
  var btn = document.getElementById('btn-fbt-run');
  var statusEl = document.getElementById('fbt-status');
  var chartWrapEl = document.getElementById('fbt-chart-wrap');
  var metricsEl = document.getElementById('fbt-metrics');
  var rebalEl2 = document.getElementById('fbt-rebalances');
  var captionEl2 = document.getElementById('fbt-caption');

  var topNRaw = parseInt(document.getElementById('fbt-topn').value, 10);
  var rebalRaw = parseInt(document.getElementById('fbt-rebal').value, 10);
  var capRaw = parseFloat(document.getElementById('fbt-cap').value);
  var topN = isFinite(topNRaw) && topNRaw > 0 ? topNRaw : 5;
  var rebal = isFinite(rebalRaw) && rebalRaw > 0 ? rebalRaw : 21;
  var cap = isFinite(capRaw) && capRaw > 0 ? capRaw : 10000000;

  if (btn) { btn.disabled = true; btn.textContent = '백테스트 실행 중… (최초 최대 60초)'; }
  if (statusEl) statusEl.style.display = 'none';
  if (chartWrapEl) chartWrapEl.style.display = 'none';
  if (metricsEl) metricsEl.style.display = 'none';
  if (rebalEl2) rebalEl2.style.display = 'none';
  if (captionEl2) captionEl2.style.display = 'none';

  fetch('/api/factors/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token() },
    body: JSON.stringify({ topN: topN, rebalanceEvery: rebal, startCapital: cap }),
  }).then(function(r) {
    if (r.status === 503) {
      return r.json().then(function() {
        if (statusEl) { statusEl.textContent = '팩터 백테스트 비활성'; statusEl.style.display = ''; }
        if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
      });
    }
    if (!r.ok) {
      return r.json().then(function(d) {
        if (statusEl) { statusEl.textContent = '오류: ' + esc(d.error || '알 수 없음'); statusEl.style.display = ''; }
        if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
      });
    }
    return r.json().then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
      renderFactorBacktest(data);
    });
  }).catch(function() {
    var s2 = document.getElementById('fbt-status');
    var b2 = document.getElementById('btn-fbt-run');
    if (s2) { s2.textContent = '네트워크 오류'; s2.style.display = ''; }
    if (b2) { b2.disabled = false; b2.textContent = '백테스트 실행'; }
  });
}
var fbtBtn = document.getElementById('btn-fbt-run');
if (fbtBtn) {
  fbtBtn.addEventListener('click', function() { runFactorBacktest(); });
}

/* ---- Portfolio Rebalance (button-only; isolated from 3s loop) ---- */
function renderRebalancePlan(plan) {
  try {
    var rbStatusEl = document.getElementById('rb-status');
    var rbPlanEl = document.getElementById('rb-plan');
    var rbSummaryEl = document.getElementById('rb-summary');
    var rbTargetsBody = document.getElementById('rb-targets-body');
    var rbOrdersSection = document.getElementById('rb-orders-section');
    var rbOrdersList = document.getElementById('rb-orders-list');
    var rbSkippedSection = document.getElementById('rb-skipped-section');
    var rbSkippedList = document.getElementById('rb-skipped-list');
    if (!plan || !rbPlanEl) return;
    var targets = Array.isArray(plan.targets) ? plan.targets : [];
    var sells = Array.isArray(plan.sells) ? plan.sells : [];
    var orders = Array.isArray(plan.ordersSubmitted) ? plan.ordersSubmitted : [];
    var skipped = Array.isArray(plan.skipped) ? plan.skipped : [];
    var rbAsOf = plan.asOf ? new Date(plan.asOf).toLocaleTimeString() : '';
    var buyCount = 0;
    for (var rbi = 0; rbi < orders.length; rbi++) { if (orders[rbi].side === 'BUY') buyCount++; }
    if (rbStatusEl) rbStatusEl.style.display = 'none';
    if (rbSummaryEl) rbSummaryEl.textContent = '매수 ' + String(buyCount) + '건 · 매도 ' + String(sells.length) + '건 · 스킵 ' + String(skipped.length) + '건' + (rbAsOf ? ' · ' + rbAsOf : '');
    if (rbTargetsBody) {
      rbTargetsBody.innerHTML = targets.slice(0, 15).map(function(t) {
        var delta = Number(t.deltaQty);
        var deltaCls = delta > 0 ? 'num pos' : delta < 0 ? 'num neg' : 'num';
        var deltaStr = delta > 0 ? '+' + String(delta) : String(delta);
        return '<tr>' +
          '<td>' + esc(t.symbol || '') + '</td>' +
          '<td class="num">' + esc(String(t.targetQty != null ? t.targetQty : '')) + '</td>' +
          '<td class="num">' + esc(String(t.currentQty != null ? t.currentQty : '')) + '</td>' +
          '<td class="' + esc(deltaCls) + '">' + esc(deltaStr) + '</td>' +
          '<td class="num">' + esc(t.price != null ? Number(t.price).toLocaleString() : '') + '</td>' +
        '</tr>';
      }).join('');
    }
    if (rbOrdersSection && rbOrdersList) {
      if (orders.length) {
        rbOrdersList.innerHTML = orders.slice(0, 20).map(function(o) {
          var oclr = o.side === 'BUY' ? 'color:#22c55e' : 'color:#ef4444';
          return '<div class="rb-order-row"><span style="' + oclr + '">' + esc(o.side || '') + '</span> ' + esc(o.symbol || '') + ' ' + esc(String(o.qty != null ? o.qty : '')) + '</div>';
        }).join('');
        rbOrdersSection.style.display = '';
      } else {
        rbOrdersSection.style.display = 'none';
      }
    }
    if (rbSkippedSection && rbSkippedList) {
      if (skipped.length) {
        rbSkippedList.innerHTML = skipped.slice(0, 10).map(function(sk) {
          return '<div class="rb-skip-row">' + esc(sk.symbol || '') + ': ' + esc(sk.reason || '') + '</div>';
        }).join('');
        rbSkippedSection.style.display = '';
      } else {
        rbSkippedSection.style.display = 'none';
      }
    }
    rbPlanEl.style.display = '';
  } catch (rbErr) {
    console.error('[rebalance] render error:', rbErr);
  }
}

var rbBtn = document.getElementById('btn-rebalance');
if (rbBtn) {
  rbBtn.addEventListener('click', function() {
    var rbB = document.getElementById('btn-rebalance');
    var rbS = document.getElementById('rb-status');
    var rbP = document.getElementById('rb-plan');
    if (rbB) { rbB.disabled = true; rbB.textContent = '리밸런싱 실행 중… (최대 30초)'; }
    if (rbS) rbS.style.display = 'none';
    if (rbP) rbP.style.display = 'none';
    fetch('/api/factors/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-token': token() },
    }).then(function(r) {
      if (r.status === 409) {
        return r.json().then(function() {
          var s = document.getElementById('rb-status');
          var b = document.getElementById('btn-rebalance');
          if (s) { s.textContent = '거래 정지 상태 — 리밸런싱 불가'; s.style.display = ''; }
          if (b) { b.disabled = false; b.textContent = '포트폴리오 리밸런싱 실행'; }
        });
      }
      if (r.status === 503) {
        return r.json().then(function() {
          var s = document.getElementById('rb-status');
          var b = document.getElementById('btn-rebalance');
          if (s) { s.textContent = '포트폴리오 배포 비활성'; s.style.display = ''; }
          if (b) { b.disabled = false; b.textContent = '포트폴리오 리밸런싱 실행'; }
        });
      }
      if (!r.ok) {
        return r.json().then(function(d) {
          var s = document.getElementById('rb-status');
          var b = document.getElementById('btn-rebalance');
          if (s) { s.textContent = d.error || '오류'; s.style.display = ''; }
          if (b) { b.disabled = false; b.textContent = '포트폴리오 리밸런싱 실행'; }
        });
      }
      return r.json().then(function(plan) {
        var b = document.getElementById('btn-rebalance');
        if (b) { b.disabled = false; b.textContent = '포트폴리오 리밸런싱 실행'; }
        renderRebalancePlan(plan);
        refreshPositions();
      });
    }).catch(function() {
      var b = document.getElementById('btn-rebalance');
      var s = document.getElementById('rb-status');
      if (b) { b.disabled = false; b.textContent = '포트폴리오 리밸런싱 실행'; }
      if (s) { s.textContent = '네트워크 오류'; s.style.display = ''; }
    });
  });
}

/* ---- Auto-rebalance toggle ---- */
function applyAutoRebalanceStatus(data) {
  try {
    var toggle = document.getElementById('arb-toggle');
    var caption = document.getElementById('arb-caption');
    if (!toggle || !caption) return;
    toggle.disabled = false;
    toggle.checked = !!data.enabled;
    var parts = [];
    if (data.intervalMs != null) {
      var hrs = Math.round(Number(data.intervalMs) / 3600000);
      parts.push('간격 ' + esc(String(hrs)) + 'h');
    }
    if (data.lastRun && data.lastRun.at != null) {
      var d = new Date(data.lastRun.at);
      var ds = d.toLocaleDateString('ko-KR') + ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      var note = data.lastRun.ok ? 'ok' : (data.lastRun.note || 'skip');
      parts.push('최근 ' + esc(ds) + ' (' + esc(note) + ')');
    }
    caption.textContent = parts.join(' · ');
  } catch (e) {
    console.error('[arb] applyAutoRebalanceStatus error:', e);
  }
}

function loadAutoRebalanceStatus() {
  try {
    var toggle = document.getElementById('arb-toggle');
    var caption = document.getElementById('arb-caption');
    if (!toggle || !caption) return;
    fetch('/api/factors/autorebalance', { headers: { 'x-api-token': token() } })
      .then(function(r) {
        if (r.status === 503) {
          if (toggle) { toggle.disabled = true; toggle.checked = false; }
          if (caption) caption.textContent = '스케줄러 비활성';
          return null;
        }
        return r.json();
      })
      .then(function(data) {
        if (data) applyAutoRebalanceStatus(data);
      })
      .catch(function(e) {
        console.error('[arb] loadAutoRebalanceStatus error:', e);
        if (caption) caption.textContent = '상태 조회 실패';
      });
  } catch (e) {
    console.error('[arb] loadAutoRebalanceStatus outer error:', e);
  }
}

var arbToggle = document.getElementById('arb-toggle');
if (arbToggle) {
  arbToggle.addEventListener('change', function() {
    try {
      var toggle = document.getElementById('arb-toggle');
      var caption = document.getElementById('arb-caption');
      if (!toggle) return;
      var enabled = toggle.checked;
      fetch('/api/factors/autorebalance', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': token() },
        body: JSON.stringify({ enabled: enabled }),
      }).then(function(r) {
        if (r.status === 503) {
          if (toggle) { toggle.disabled = true; toggle.checked = false; }
          if (caption) caption.textContent = '스케줄러 비활성';
          return null;
        }
        return r.json();
      }).then(function(data) {
        if (data) applyAutoRebalanceStatus(data);
      }).catch(function(e) {
        console.error('[arb] toggle change error:', e);
        if (caption) caption.textContent = '오류';
      });
    } catch (e) {
      console.error('[arb] toggle outer error:', e);
    }
  });
}

/* ---- 성과 (Performance) view — fetch on open + strategy/mode change only, NOT in 3s poll ---- */
var perfChart = null;
var perfSeries = null;

function ensurePerfChart(el) {
  if (perfChart) return true;
  try {
    var made = ensureAreaChart(el, '#3b82f6', 'rgba(59,130,246,0.25)', 'rgba(59,130,246,0.02)');
    perfChart = made.chart;
    perfSeries = made.series;
    return true;
  } catch (e) {
    console.error('[perf-chart] init failed:', e);
    perfChart = null;
    perfSeries = null;
    return false;
  }
}

function loadPerfData() {
  var stratEl = document.getElementById('perf-strategy');
  var modeEl = document.getElementById('perf-mode');
  var statusEl = document.getElementById('perf-status');
  var metricsEl = document.getElementById('perf-metrics');
  var chartWrapEl = document.getElementById('perf-chart-wrap');
  var emptyEl = document.getElementById('perf-empty');
  var strategyId = stratEl ? stratEl.value : '1000';
  var mode = modeEl ? modeEl.value : 'PAPER';
  if (!strategyId) return;

  if (statusEl) { statusEl.textContent = '로딩 중…'; statusEl.style.display = ''; }
  if (metricsEl) metricsEl.style.display = 'none';
  if (chartWrapEl) chartWrapEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'none';

  fetch('/api/performance?strategyId=' + encodeURIComponent(strategyId) + '&mode=' + encodeURIComponent(mode), {
    headers: { 'x-api-token': token() },
  }).then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, status: r.status, data: d }; });
  }).then(function(res) {
    if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
    if (!res.ok) {
      if (statusEl) { statusEl.textContent = esc(String(res.data.error || '오류')); statusEl.style.display = ''; }
      return;
    }
    var metrics = res.data.metrics || {};
    var equityCurve = res.data.equityCurve || [];

    /* metrics strip */
    var ret = Number(metrics.totalReturn) || 0;
    var mdd = Number(metrics.maxDrawdown) || 0;
    var wr = Number(metrics.winRate) || 0;
    var pf = Number(metrics.profitFactor) || 0;
    var tc = Number(metrics.tradeCount) || 0;
    var awl = Number(metrics.avgWinLoss) || 0;
    var mRetEl = document.getElementById('perf-m-ret');
    var mMddEl = document.getElementById('perf-m-mdd');
    var mWrEl = document.getElementById('perf-m-wr');
    var mPfEl = document.getElementById('perf-m-pf');
    var mTcEl = document.getElementById('perf-m-tc');
    var mAwlEl = document.getElementById('perf-m-awl');
    if (mRetEl) { mRetEl.textContent = (ret * 100).toFixed(2) + '%'; mRetEl.className = 'mval ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu'); }
    if (mMddEl) { mMddEl.textContent = (mdd * 100).toFixed(2) + '%'; mMddEl.className = 'mval neg'; }
    if (mWrEl) { mWrEl.textContent = (wr * 100).toFixed(1) + '%'; mWrEl.className = 'mval neu'; }
    if (mPfEl) { mPfEl.textContent = isFinite(pf) ? pf.toFixed(2) : '∞'; mPfEl.className = 'mval neu'; }
    if (mTcEl) { mTcEl.textContent = String(tc); mTcEl.className = 'mval neu'; }
    if (mAwlEl) { mAwlEl.textContent = awl.toFixed(2); mAwlEl.className = 'mval neu'; }
    if (metricsEl) metricsEl.style.display = 'flex';

    /* equity curve chart */
    var perfChartEl = document.getElementById('perf-chart');
    try {
      if (equityCurve.length && perfChartEl) {
        if (chartWrapEl) chartWrapEl.style.display = '';
        if (ensurePerfChart(perfChartEl)) {
          var seen3 = {};
          var curveData = equityCurve.map(function(p) {
            return { time: Math.floor(new Date(p.day).getTime() / 1000), value: Number(p.nav) };
          }).sort(function(a, b) { return a.time - b.time; }).filter(function(p) {
            if (seen3[p.time]) return false;
            seen3[p.time] = true;
            return true;
          });
          if (perfSeries) perfSeries.setData(curveData);
          if (perfChart) {
            perfChart.applyOptions({ width: perfChartEl.offsetWidth, height: perfChartEl.offsetHeight });
            perfChart.timeScale().fitContent();
          }
        }
      } else if (!equityCurve.length) {
        if (emptyEl) emptyEl.style.display = '';
      }
    } catch (chartErr) {
      console.error('[perf-chart] render failed:', chartErr);
    }
  }).catch(function(e) {
    console.error('[perf] loadPerfData error:', e);
    if (statusEl) { statusEl.textContent = '네트워크 오류'; statusEl.style.display = ''; }
  });
}

var perfStratEl = document.getElementById('perf-strategy');
if (perfStratEl) {
  perfStratEl.addEventListener('change', function() { loadPerfData(); });
}
var perfModeEl = document.getElementById('perf-mode');
if (perfModeEl) {
  perfModeEl.addEventListener('change', function() { loadPerfData(); });
}

/* ---- Settings: API_TOKEN (localStorage) ---- */
var tokenInput = document.getElementById('api-token-input');
var tokenSaveBtn = document.getElementById('api-token-save');
var tokenStatus = document.getElementById('api-token-status');
if (tokenInput) tokenInput.value = token();
if (tokenSaveBtn) {
  tokenSaveBtn.addEventListener('click', function() {
    var v = tokenInput ? tokenInput.value : '';
    if (v) {
      localStorage.setItem('apiToken', v);
      if (tokenStatus) tokenStatus.textContent = '저장됨 (마스킹)';
    } else {
      localStorage.removeItem('apiToken');
      if (tokenStatus) tokenStatus.textContent = '삭제됨';
    }
  });
}
<\/script>
</body>
</html>`;

