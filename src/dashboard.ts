import * as vscode from 'vscode';

export interface AuditListener {
    (event: { ts: number; kind: string; client: string; detail: string }): void;
}
export interface DashboardClientInfo {
    clientId: string;
    label: string;
    preset: string;
    calls: number;
    denied: number;
    lastSeen: number;
    estTokens: number;
}
interface ToolUsageEntry {
    tool: string;
    client: string;
    ts: number;
    ms: number;
    estTokens: number;
    denied: boolean;
}
let panelRef: Dashboard | undefined;
export function setDashboardRef(d: Dashboard): void { panelRef = d; }
export function notifyDashboard(event: { ts: number; kind: string; client: string; detail: string }): void {
    try { panelRef?.pushLiveExternal({ type: 'audit', event }); } catch {}
}
export function estimateTokens(result: unknown): number {
    try {
        let len = 0;
        const obj = result as { content?: Array<{ type?: string; text?: string }> };
        if (obj && Array.isArray(obj.content)) for (const c of obj.content) if (typeof c?.text === 'string') len += c.text.length;
        return Math.ceil(len / 4);
    } catch { return 0; }
}
export class Dashboard {
    private panel?: vscode.WebviewPanel;
    private usage: ToolUsageEntry[] = [];
    private clients = new Map<string, DashboardClientInfo>();
    private paused = false;
    setClientPreset(clientId: string, preset: string): void {
        const info = this.clients.get(clientId);
        if (info) info.preset = preset;
        else this.clients.set(clientId, { clientId, label: clientId, preset, calls: 0, denied: 0, lastSeen: 0, estTokens: 0 });
    }
    recordToolCall(tool: string, client: string, ms: number, estTokens: number, denied: boolean): void {
        this.usage.push({ tool, client, ts: Date.now(), ms, estTokens, denied });
        if (this.usage.length > 2000) this.usage = this.usage.slice(-1500);
        const info = this.clients.get(client) ?? { clientId: client, label: client, preset: '—', calls: 0, denied: 0, lastSeen: 0, estTokens: 0 };
        info.calls += 1; if (denied) info.denied += 1; info.estTokens += estTokens; info.lastSeen = Date.now();
        this.clients.set(client, info);
        this.pushLive({ type: 'call', call: { tool, client, ms, estTokens, denied, ts: Date.now() } });
    }
    recordBlocked(kind: string, detail: string): void { this.pushLive({ type: 'blocked', kind, detail, ts: Date.now() }); }
    pushLiveExternal(msg: unknown): void { this.pushLive(msg); }
    private pushLive(msg: unknown): void { if (!this.paused && this.panel) this.panel.webview.postMessage(msg).then(() => undefined, () => undefined); }
    show(context: vscode.ExtensionContext): void {
        if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
        const panel = vscode.window.createWebviewPanel('mcpDashboard', 'MCP Server — Instrument', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        this.panel = panel;
        panel.onDidDispose(() => { this.panel = undefined; }, null, context.subscriptions);
        panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
        panel.webview.html = this.renderHtml();
        this.sendSnapshot();
    }
    private onMessage(msg: { type?: string; pause?: boolean }): void {
        switch (msg.type) {
            case 'snapshot': this.sendSnapshot(); break;
            case 'pause': this.paused = Boolean(msg.pause); break;
            case 'clear': this.usage = []; this.clients.clear(); this.sendSnapshot(); break;
        }
    }
    private sendSnapshot(): void {
        if (!this.panel) return;
        const totalTokens = this.usage.reduce((a, u) => a + u.estTokens, 0);
        const byTool = new Map<string, { calls: number; tokens: number }>();
        for (const u of this.usage) { const e = byTool.get(u.tool) ?? { calls: 0, tokens: 0 }; e.calls += 1; e.tokens += u.estTokens; byTool.set(u.tool, e); }
        this.panel.webview.postMessage({ type: 'snapshot', clients: [...this.clients.values()], feed: this.usage.slice(-80), totals: { calls: this.usage.length, tokens: totalTokens, denied: this.usage.filter(u => u.denied).length, topTools: [...byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6).map(([tool, v]) => ({ tool, ...v })) } }).then(() => undefined, () => undefined);
    }
    private renderHtml(): string {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
/* ── Design tokens — Instrument Lab ── */
:root{
  --ink:#0F1419; --surface:#161E26; --surface-2:#1D2A36; --line:rgba(255,255,255,.08);
  --line-strong:rgba(255,255,255,.14); --paper:#F4F1EC; --paper-dim:#B8B0A3;
  --amber:#FFB84D; --amber-dim:rgba(255,184,77,.15); --amber-line:rgba(255,184,77,.35);
  --signal:#4EC9B0; --signal-dim:rgba(78,201,176,.14);
  --danger:#FF6B6B; --danger-dim:rgba(255,107,107,.14);
  --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, monospace;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
body{
  font-family:var(--sans); font-size:12px; line-height:1.5;
  color:var(--paper); background:var(--ink);
  min-height:100vh; padding:0;
  -webkit-font-smoothing:antialiased;
}
/* ── Header — instrument fascia ── */
.fascia{
  display:flex; align-items:center; gap:14px;
  padding:14px 18px 12px; border-bottom:1px solid var(--line);
  background: linear-gradient(180deg, rgba(255,184,77,.06) 0%, transparent 100%), var(--surface);
  position:sticky; top:0; z-index:10;
}
.mark{
  width:28px; height:28px; border:1px solid var(--amber-line); border-radius:6px;
  display:grid; place-items:center; background:var(--amber-dim);
  font-family:var(--mono); font-size:11px; font-weight:700; color:var(--amber); letter-spacing:.04em;
}
.fascia h1{
  font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--paper);
}
.fascia h1 span{font-weight:400; color:var(--paper-dim); letter-spacing:.08em}
.fascia .rule{flex:1; height:1px; background:var(--line); margin:0 10px}
.pill{
  font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase;
  padding:4px 9px; border-radius:999px; border:1px solid var(--line-strong); color:var(--paper-dim);
  display:inline-flex; align-items:center; gap:6px;
}
.pill.live{border-color:var(--amber-line); color:var(--amber); background:var(--amber-dim)}
.pill.live i{width:6px;height:6px;border-radius:50%;background:var(--amber);box-shadow:0 0 8px var(--amber);animation:blink 1.6s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.pill.paused{border-color:rgba(255,107,107,.4); color:var(--danger); background:var(--danger-dim); display:none}
.toolbar{display:flex; gap:6px; margin-left:4px}
.btn{
  font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase;
  padding:5px 10px; border-radius:6px; border:1px solid var(--line-strong);
  background:rgba(255,255,255,.04); color:var(--paper); cursor:pointer;
}
.btn:hover{background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.18)}
.btn.primary{background:var(--amber); color:var(--ink); border-color:var(--amber); font-weight:700}
.btn.primary:hover{background:#FFC66A}
.btn.ghost{background:transparent}
/* ── Layout ── */
.shell{padding:16px 18px 20px; max-width:1100px; margin:0 auto}
.eyebrow{font-family:var(--mono); font-size:9px; letter-spacing:.14em; text-transform:uppercase; color:var(--paper-dim); margin-bottom:8px; display:flex; align-items:center; gap:8px}
.eyebrow::before{content:""; width:14px; height:1px; background:var(--amber-line)}
.kpis{display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px}
.kpi{
  background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px;
  position:relative; overflow:hidden;
}
.kpi::after{content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--amber); opacity:.9}
.kpi.signal::after{background:var(--signal)}
.kpi.danger::after{background:var(--danger)}
.kpi .label{font-family:var(--mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--paper-dim)}
.kpi .value{font-family:var(--mono); font-size:28px; font-weight:300; letter-spacing:-.03em; color:var(--paper); margin-top:4px; font-variant-numeric:tabular-nums}
.kpi .value small{font-size:11px; font-weight:400; color:var(--paper-dim); letter-spacing:.04em; margin-left:4px}
.kpi .foot{font-size:11px; color:var(--paper-dim); margin-top:6px; display:flex; gap:6px; align-items:center}
.kpi .foot b{color:var(--paper); font-weight:600}
.spark{height:18px; display:flex; align-items:end; gap:2px; margin-top:8px; opacity:.9}
.spark i{display:block; width:3px; border-radius:2px; background:var(--amber); opacity:.85}
.kpi.signal .spark i{background:var(--signal)}
.kpi.danger .spark i{background:var(--danger)}
.grid{display:grid; grid-template-columns:1.35fr .85fr; gap:10px; margin-bottom:14px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:1fr}}
.panel{
  background:var(--surface); border:1px solid var(--line); border-radius:10px; overflow:hidden;
}
.panel-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px; border-bottom:1px solid var(--line);
  font-family:var(--mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--paper-dim);
}
.panel-head b{color:var(--paper); font-weight:600; letter-spacing:.1em}
.count{font-family:var(--mono); font-size:10px; color:var(--paper-dim); border:1px solid var(--line); padding:2px 7px; border-radius:999px}
/* ── Clients — signal traces ── */
.clients{padding:6px 0}
.client-row{
  display:grid; grid-template-columns:1fr auto auto auto; gap:10px; align-items:center;
  padding:9px 14px; border-bottom:1px solid rgba(255,255,255,.05);
  font-family:var(--mono); font-size:11px;
}
.client-row:last-child{border-bottom:none}
.client-name{font-weight:600; color:var(--paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.client-meta{font-size:10px; color:var(--paper-dim)}
.badge{
  font-family:var(--mono); font-size:9px; letter-spacing:.08em; text-transform:uppercase;
  padding:3px 7px; border-radius:999px; border:1px solid var(--line-strong); color:var(--paper-dim);
}
.badge.std{border-color:rgba(78,201,176,.35); color:var(--signal); background:var(--signal-dim)}
.badge.ro{border-color:rgba(255,184,77,.3); color:var(--amber)}
.badge.full{border-color:rgba(255,255,255,.18); color:var(--paper)}
.badge.deny{border-color:rgba(255,107,107,.35); color:var(--danger)}
.num{font-variant-numeric:tabular-nums; text-align:right; min-width:32px}
.num.bad{color:var(--danger)}
/* ── Top tools — ranked ── */
.rank{padding:8px 14px}
.rank-row{display:grid; grid-template-columns: 1fr 44px 52px; gap:10px; align-items:center; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.05); font-family:var(--mono); font-size:11px}
.rank-row:last-child{border:none}
.rank-name{color:var(--paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px}
.rank-bar{height:4px; background:rgba(255,255,255,.08); border-radius:999px; overflow:hidden}
.rank-fill{height:100%; background:var(--amber); border-radius:999px; transition:width .4s ease}
.rank-meta{font-size:10px; color:var(--paper-dim); text-align:right; font-variant-numeric:tabular-nums}
/* ── Tape — live activity (signature) ── */
.tape-head{display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--line)}
.tape-title{font-family:var(--mono); font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--paper-dim)}
.tape-title b{color:var(--paper)}
.tape-rule{flex:1; height:1px; background: repeating-linear-gradient(90deg, var(--line) 0 6px, transparent 6px 10px)}
.tape{
  max-height:300px; overflow:auto; background:
    linear-gradient(180deg, rgba(255,184,77,.03) 0%, transparent 28%),
    repeating-linear-gradient(0deg, transparent 0 24px, rgba(255,255,255,.02) 24px 25px),
    var(--surface-2);
  font-family:var(--mono); font-size:11px;
  scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent;
}
.tape .row{
  display:grid; grid-template-columns: 72px 1fr auto; gap:10px; align-items:center;
  padding:6px 14px; border-bottom:1px solid rgba(255,255,255,.06);
  position:relative;
}
.tape .row::before{content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:transparent}
.tape .row.ok::before{background:var(--signal); opacity:.9}
.tape .row.denied::before{background:var(--danger); opacity:.9}
.tape .row.blocked::before{background:var(--amber); opacity:.9}
.t{color:var(--paper-dim); font-variant-numeric:tabular-nums; font-size:10px}
.tool{color:var(--paper); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.tool.denied{color:var(--danger)}
.client{color:var(--paper-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.meta{color:var(--paper-dim); font-size:10px; white-space:nowrap}
.empty{padding:22px 14px; text-align:center; color:var(--paper-dim); font-style:italic; font-family:var(--sans); font-size:12px}
.empty strong{color:var(--paper); font-style:normal}
.hint{padding:10px 14px; border-top:1px solid var(--line); font-size:11px; color:var(--paper-dim); display:flex; gap:10px; flex-wrap:wrap}
.hint kbd{font-family:var(--mono); font-size:10px; padding:2px 6px; border:1px solid var(--line-strong); border-bottom-width:2px; border-radius:4px; background:rgba(255,255,255,.06); color:var(--paper)}
</style></head>
<body>
  <header class="fascia">
    <div class="mark">MCP</div>
    <h1>Instrument <span>· signal lab</span></h1>
    <div class="rule"></div>
    <span class="pill live"><i></i> Live</span>
    <span class="pill paused" id="pausedBadge">Paused</span>
    <div class="toolbar">
      <button class="btn ghost" id="pauseBtn">Pause</button>
      <button class="btn ghost" id="clearBtn">Clear</button>
      <button class="btn primary" id="refreshBtn">Refresh</button>
    </div>
  </header>

  <div class="shell">
    <div class="eyebrow">System telemetry</div>
    <section class="kpis">
      <div class="kpi">
        <div class="label">Total calls</div>
        <div class="value" id="kCalls">0</div>
        <div class="foot"><span id="kCallsFoot">No activity yet</span></div>
        <div class="spark" id="sparkCalls" aria-hidden="true"></div>
      </div>
      <div class="kpi signal">
        <div class="label">Est. tokens · model cost</div>
        <div class="value" id="kTokens">0 <small>~chars ÷ 4</small></div>
        <div class="foot" id="kTokensFoot">Across all clients</div>
        <div class="spark" id="sparkTokens" aria-hidden="true"></div>
      </div>
      <div class="kpi danger">
        <div class="label">Denied / blocked</div>
        <div class="value" id="kDenied">0</div>
        <div class="foot" id="kDeniedFoot">Policy enforcements</div>
        <div class="spark" id="sparkDenied" aria-hidden="true"></div>
      </div>
    </section>

    <div class="grid">
      <section class="panel">
        <div class="panel-head"><b>Clients</b> <span class="count" id="clientsCount">0</span></div>
        <div class="clients" id="clientsBody"><div class="empty"><strong>No client connected yet.</strong><br>Open Mammouth or Claude and the trace appears here.</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><b>Top tools by tokens</b> <span class="count">tokens · calls</span></div>
        <div class="rank" id="topTools"><div class="empty">No data yet — run a tool to see the ranking.</div></div>
      </section>
    </div>

    <section class="panel">
      <div class="tape-head">
        <div class="tape-title"><b>Tape</b> · live activity</div>
        <div class="tape-rule"></div>
        <span class="pill" id="tapePill" style="font-size:9px">80 most recent</span>
      </div>
      <div class="tape" id="feed" role="log" aria-live="polite"><div class="empty"><strong>Waiting for activity…</strong><br>Every tool call, denied scope, and blocked shell lands here in real time.</div></div>
      <div class="hint">
        <span><kbd>Pause</kbd> freezes the tape without dropping events</span>
        <span><kbd>Clear</kbd> resets counters</span>
        <span><kbd>Refresh</kbd> reloads snapshot</span>
      </div>
    </section>
  </div>

<script>
const vsapi = acquireVsCodeApi();
let paused = false;
const els = {
  pauseBtn: document.getElementById('pauseBtn'),
  pausedBadge: document.getElementById('pausedBadge'),
  kCalls: document.getElementById('kCalls'),
  kTokens: document.getElementById('kTokens'),
  kDenied: document.getElementById('kDenied'),
  kCallsFoot: document.getElementById('kCallsFoot'),
  kDeniedFoot: document.getElementById('kDeniedFoot'),
  sparkCalls: document.getElementById('sparkCalls'),
  sparkTokens: document.getElementById('sparkTokens'),
  sparkDenied: document.getElementById('sparkDenied'),
  clientsBody: document.getElementById('clientsBody'),
  clientsCount: document.getElementById('clientsCount'),
  topTools: document.getElementById('topTools'),
  feed: document.getElementById('feed'),
  tapePill: document.getElementById('tapePill'),
};
els.pauseBtn.addEventListener('click', () => {
  paused = !paused;
  els.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  els.pausedBadge.style.display = paused ? 'inline-flex' : 'none';
  vsapi.postMessage({ type: 'pause', pause: paused });
});
document.getElementById('clearBtn').addEventListener('click', () => vsapi.postMessage({ type: 'clear' }));
document.getElementById('refreshBtn').addEventListener('click', () => vsapi.postMessage({ type: 'snapshot' }));

function esc(s){ const d=document.createElement('div'); d.textContent=String(s??''); return d.innerHTML; }
function fmtT(n){ return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n)); }
function fmtTime(ts){ const d=new Date(ts); return d.toTimeString().slice(0,8); }
function spark(el, values, color){
  el.innerHTML = values.map(v => '<i style="height:'+Math.max(3,Math.min(18, v))+'px;'+(color?'background:'+color:'')+'"></i>').join('');
}

let histCalls=[], histTokens=[], histDenied=[];
function pushHist(arr, v){ arr.push(v); if(arr.length>18) arr.shift(); }

function addFeedRow(call){
  const empty = els.feed.querySelector('.empty'); if(empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'row ' + (call.denied ? 'denied' : 'ok');
  row.innerHTML = '<span class="t">'+fmtTime(call.ts)+'</span>'
    + '<span class="tool'+(call.denied?' denied':'')+'">'+esc(call.denied ? 'DENIED · '+call.tool : call.tool)+'</span>'
    + '<span class="client">'+esc(call.client)+'</span>'
    + '<span class="meta">'+call.ms+'ms · ~'+fmtT(call.estTokens)+'</span>';
  els.feed.prepend(row);
  while(els.feed.children.length>90) els.feed.lastChild.remove();
}
function addBlockedRow(m){
  const empty = els.feed.querySelector('.empty'); if(empty) empty.remove();
  const row = document.createElement('div'); row.className='row blocked';
  row.innerHTML = '<span class="t">'+fmtTime(m.ts)+'</span><span class="tool denied">⛔ '+esc(m.kind)+'</span><span class="client">'+esc(m.detail).slice(0,88)+'</span><span class="meta">blocked</span>';
  els.feed.prepend(row);
}

let counters={calls:0,tokens:0,denied:0};
function refreshCounters(call){
  counters.calls++; counters.tokens+=call.estTokens; if(call.denied) counters.denied++;
  els.kCalls.textContent = counters.calls;
  els.kTokens.innerHTML = fmtT(counters.tokens)+' <small>~chars ÷ 4</small>';
  els.kDenied.textContent = counters.denied;
  els.kCallsFoot.textContent = counters.calls===1 ? '1 call' : counters.calls+' calls';
  els.kDeniedFoot.textContent = counters.denied ? counters.denied+' enforcements' : 'No enforcements';
  pushHist(histCalls, 6 + Math.min(12, call.ms/18));
  pushHist(histTokens, 5 + Math.min(13, call.estTokens/900));
  pushHist(histDenied, call.denied ? 16 : 3);
  spark(els.sparkCalls, histCalls, ''); spark(els.sparkTokens, histTokens, ''); spark(els.sparkDenied, histDenied, '');
}
window.addEventListener('message', ev => {
  const m=ev.data;
  if(m.type==='call'){ addFeedRow(m.call); refreshCounters(m.call); }
  else if(m.type==='blocked'){ addBlockedRow(m); }
  else if(m.type==='audit'){ addBlockedRow({ts:m.event.ts, kind:m.event.kind, detail:m.event.detail}); }
  else if(m.type==='snapshot') renderSnapshot(m);
});
function renderSnapshot(m){
  counters={calls:m.totals.calls, tokens:m.totals.tokens, denied:m.totals.denied};
  els.kCalls.textContent=counters.calls; els.kTokens.innerHTML=fmtT(counters.tokens)+' <small>~chars ÷ 4</small>'; els.kDenied.textContent=counters.denied;
  els.kCallsFoot.textContent = counters.calls ? counters.calls+' calls' : 'No activity yet';
  els.kDeniedFoot.textContent = counters.denied ? counters.denied+' enforcements' : 'No enforcements';
  els.clientsCount.textContent = m.clients.length;
  if(m.clients.length){
    els.clientsBody.innerHTML = m.clients.map(c => {
      const badge = c.preset==='Standard' ? 'std' : c.preset==='Read only' ? 'ro' : c.preset==='Full access' ? 'full' : 'deny';
      return '<div class="client-row"><span class="client-name">'+esc(c.label)+'</span><span class="badge '+badge+'">'+esc(c.preset)+'</span><span class="num">'+c.calls+'</span><span class="num '+(c.denied?'bad':'')+'">'+(c.denied||0)+'</span><span class="num" style="color:var(--paper-dim)">~'+fmtT(c.estTokens)+'</span></div>';
    }).join('');
    // header row
    els.clientsBody.insertAdjacentHTML('afterbegin','<div class="client-row" style="opacity:.55; font-size:9px; letter-spacing:.08em; text-transform:uppercase; border-bottom:1px solid var(--line)"><span>Client</span><span>Preset</span><span style="text-align:right">Calls</span><span style="text-align:right">Denied</span><span style="text-align:right">Tokens</span></div>');
  } else {
    els.clientsBody.innerHTML = '<div class="empty"><strong>No client connected yet.</strong><br>Open Mammouth or Claude and the trace appears here.</div>';
  }
  if(m.totals.topTools.length){
    const max = Math.max(1, m.totals.topTools[0].tokens);
    els.topTools.innerHTML = m.totals.topTools.map(t => '<div class="rank-row"><span class="rank-name">'+esc(t.tool)+'</span><span class="rank-meta">~'+fmtT(t.tokens)+'</span><span class="rank-meta">'+t.calls+'×</span></div><div class="rank-bar"><div class="rank-fill" style="width:'+Math.max(4, t.tokens/max*100)+'%"></div></div>').join('');
  } else {
    els.topTools.innerHTML = '<div class="empty">No data yet — run a tool to see the ranking.</div>';
  }
  // feed is live-driven; snapshot does not overwrite it — only counters
  spark(els.sparkCalls, histCalls, ''); spark(els.sparkTokens, histTokens, ''); spark(els.sparkDenied, histDenied, '');
}
vsapi.postMessage({ type:'snapshot' });
</script>
</body></html>`;
    }
}
