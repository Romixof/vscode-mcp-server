import * as vscode from 'vscode';
export interface DashboardClientInfo { clientId: string; label: string; preset: string; calls: number; denied: number; lastSeen: number; estTokens: number; }
interface ToolUsageEntry { tool: string; client: string; ts: number; ms: number; estTokens: number; denied: boolean; }
let panelRef: Dashboard | undefined;
export function setDashboardRef(d: Dashboard): void { panelRef = d; }
export function notifyDashboard(event: { ts: number; kind: string; client: string; detail: string }): void { try { panelRef?.pushLiveExternal({ type: 'audit', event }); } catch {} }
export function estimateTokens(result: unknown): number { try { let len = 0; const obj = result as { content?: Array<{ type?: string; text?: string }> }; if (obj && Array.isArray(obj.content)) for (const c of obj.content) if (typeof c?.text === 'string') len += c.text.length; return Math.ceil(len / 4); } catch { return 0; } }
export class Dashboard {
    private panel?: vscode.WebviewPanel;
    private usage: ToolUsageEntry[] = [];
    private clients = new Map<string, DashboardClientInfo>();
    private paused = false;
    setClientPreset(clientId: string, preset: string): void { const info = this.clients.get(clientId); if (info) info.preset = preset; else this.clients.set(clientId, { clientId, label: clientId, preset, calls: 0, denied: 0, lastSeen: 0, estTokens: 0 }); }
    recordToolCall(tool: string, client: string, ms: number, estTokens: number, denied: boolean): void { this.usage.push({ tool, client, ts: Date.now(), ms, estTokens, denied }); if (this.usage.length > 2000) this.usage = this.usage.slice(-1500); const info = this.clients.get(client) ?? { clientId: client, label: client, preset: '—', calls: 0, denied: 0, lastSeen: 0, estTokens: 0 }; info.calls += 1; if (denied) info.denied += 1; info.estTokens += estTokens; info.lastSeen = Date.now(); this.clients.set(client, info); this.pushLive({ type: 'call', call: { tool, client, ms, estTokens, denied, ts: Date.now() } }); }
    recordBlocked(kind: string, detail: string): void { this.pushLive({ type: 'blocked', kind, detail, ts: Date.now() }); }
    pushLiveExternal(msg: unknown): void { this.pushLive(msg); }
    private pushLive(msg: unknown): void { if (!this.paused && this.panel) this.panel.webview.postMessage(msg).then(() => undefined, () => undefined); }
    show(context: vscode.ExtensionContext): void { if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; } const panel = vscode.window.createWebviewPanel('mcpDashboard', 'MCP Server', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true }); this.panel = panel; panel.onDidDispose(() => { this.panel = undefined; }, null, context.subscriptions); panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)); panel.webview.html = this.renderHtml(); this.sendSnapshot(); }
    private onMessage(msg: { type?: string; pause?: boolean }): void { switch (msg.type) { case 'snapshot': this.sendSnapshot(); break; case 'pause': this.paused = Boolean(msg.pause); break; case 'clear': this.usage = []; this.clients.clear(); this.sendSnapshot(); break; } }
    private sendSnapshot(): void { if (!this.panel) return; const totalTokens = this.usage.reduce((a, u) => a + u.estTokens, 0); const byTool = new Map<string, { calls: number; tokens: number }>(); for (const u of this.usage) { const e = byTool.get(u.tool) ?? { calls: 0, tokens: 0 }; e.calls += 1; e.tokens += u.estTokens; byTool.set(u.tool, e); } this.panel.webview.postMessage({ type: 'snapshot', clients: [...this.clients.values()], feed: this.usage.slice(-80), totals: { calls: this.usage.length, tokens: totalTokens, denied: this.usage.filter(u => u.denied).length, topTools: [...byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6).map(([tool, v]) => ({ tool, ...v })) } }).then(() => undefined, () => undefined); }
    private renderHtml(): string {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--border:var(--vscode-widget-border,var(--vscode-panel-border,#e5e7eb));--muted:var(--vscode-descriptionForeground,#6b7280);--accent:var(--vscode-textLink-foreground,#0ea5e9)}
body{font-family:var(--vscode-font-family,Inter,system-ui,-apple-system,sans-serif);font-size:13px;line-height:1.5;color:var(--vscode-foreground);background:var(--vscode-editor-background);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:10}
.header h1{font-size:13px;font-weight:600;letter-spacing:-0.01em}
.header h1 span{font-weight:400;color:var(--muted)}
.header-right{display:flex;align-items:center;gap:10px}
.live{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}
.live i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.live.paused i{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.btn{font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--vscode-button-secondaryBackground,var(--vscode-editor-background));color:var(--vscode-foreground);cursor:pointer}
.btn:hover{background:var(--vscode-list-hoverBackground)}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn.primary:hover{opacity:.9}
.wrap{max-width:1000px;margin:0 auto;padding:20px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
@media(max-width:640px){.stats{grid-template-columns:1fr}}
.card{background:var(--vscode-sideBar-background,var(--vscode-editor-background));border:1px solid var(--border);border-radius:12px;padding:16px}
.card-label{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.card-value{font-size:26px;font-weight:650;letter-spacing:-.02em;line-height:1}
.card-value small{font-size:11px;font-weight:400;color:var(--muted);margin-left:4px}
.card-hint{font-size:12px;color:var(--muted);margin-top:6px}
.grid{display:grid;grid-template-columns:1.4fr .9fr;gap:12px;margin-bottom:16px}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
.panel{background:var(--vscode-sideBar-background,var(--vscode-editor-background));border:1px solid var(--border);border-radius:12px;overflow:hidden}
.panel-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border)}
.panel-title{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.count{font-size:11px;color:var(--muted);background:var(--vscode-badge-background,rgba(0,0,0,.06));padding:2px 8px;border-radius:999px}
.table{width:100%;border-collapse:collapse}
.table th{font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);text-align:left;padding:8px 14px;border-bottom:1px solid var(--border)}
.table td{padding:9px 14px;border-bottom:1px solid var(--border);font-size:12px}
.table tr:last-child td{border-bottom:none}
.badge{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.badge.ok{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.2);color:#15803d}
.badge.warn{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.2);color:#92400e}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.rank{padding:8px 14px}
.rank-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.rank-row:last-child{border-bottom:none}
.rank-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.rank-bar{width:72px;height:6px;border-radius:999px;background:var(--vscode-progressBar-background,rgba(0,0,0,.08));overflow:hidden;flex-shrink:0}
.rank-fill{height:100%;background:var(--accent);border-radius:999px}
.rank-meta{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:56px;text-align:right}
.feed{max-height:320px;overflow:auto}
.feed-row{display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px}
.feed-row:last-child{border-bottom:none}
.feed-time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11px}
.feed-tool{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-tool.bad{color:#dc2626}
.feed-client{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-meta{color:var(--muted);font-size:11px;white-space:nowrap}
.empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
.empty strong{color:var(--vscode-foreground);font-weight:600}
</style></head>
<body>
<header class="header">
  <h1>MCP Server <span>— Dashboard</span></h1>
  <div class="header-right">
    <span class="live" id="livePill"><i></i><span id="liveText">Live</span></span>
    <button class="btn" id="pauseBtn">Pause</button>
    <button class="btn" id="clearBtn">Clear</button>
    <button class="btn primary" id="refreshBtn">Refresh</button>
  </div>
</header>
<div class="wrap">
  <section class="stats">
    <div class="card"><div class="card-label">Total calls</div><div class="card-value" id="kCalls">0</div><div class="card-hint" id="kCallsHint">No activity yet</div></div>
    <div class="card"><div class="card-label">Estimated tokens</div><div class="card-value" id="kTokens">0 <small>~chars / 4</small></div><div class="card-hint">Across all clients</div></div>
    <div class="card"><div class="card-label">Denied / blocked</div><div class="card-value" id="kDenied">0</div><div class="card-hint">Policy enforcements</div></div>
  </section>
  <div class="grid">
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Clients</span><span class="count" id="clientsCount">0</span></div>
      <table class="table"><thead><tr><th>Client</th><th>Preset</th><th style="text-align:right">Calls</th><th style="text-align:right">Denied</th><th style="text-align:right">Tokens</th></tr></thead><tbody id="clientsBody"></tbody></table>
      <div class="empty" id="clientsEmpty"><strong>No client connected yet.</strong><br>Open Mammouth or Claude — it appears here instantly.</div>
    </section>
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Top tools</span><span class="count">by tokens</span></div>
      <div class="rank" id="topTools"></div>
      <div class="empty" id="topEmpty">No data yet — run a tool to see ranking.</div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-head"><span class="panel-title">Live activity</span><span class="count" id="feedCount">80 most recent</span></div>
    <div class="feed" id="feed" role="log" aria-live="polite"></div>
    <div class="empty" id="feedEmpty"><strong>Waiting for activity…</strong><br>Every tool call and blocked action appears here in real time.</div>
  </section>
</div>
<script>
const vsapi=acquireVsCodeApi();
let paused=false;
const els={
  pauseBtn:document.getElementById('pauseBtn'),livePill:document.getElementById('livePill'),liveText:document.getElementById('liveText'),
  kCalls:document.getElementById('kCalls'),kTokens:document.getElementById('kTokens'),kDenied:document.getElementById('kDenied'),kCallsHint:document.getElementById('kCallsHint'),
  clientsBody:document.getElementById('clientsBody'),clientsEmpty:document.getElementById('clientsEmpty'),clientsCount:document.getElementById('clientsCount'),
  topTools:document.getElementById('topTools'),topEmpty:document.getElementById('topEmpty'),
  feed:document.getElementById('feed'),feedEmpty:document.getElementById('feedEmpty')
};
function setPaused(v){paused=v;els.pauseBtn.textContent=paused?'Resume':'Pause';els.livePill.classList.toggle('paused',paused);els.liveText.textContent=paused?'Paused':'Live';vsapi.postMessage({type:'pause',pause:paused})}
els.pauseBtn.addEventListener('click',()=>setPaused(!paused));
document.getElementById('clearBtn').addEventListener('click',()=>vsapi.postMessage({type:'clear'}));
document.getElementById('refreshBtn').addEventListener('click',()=>vsapi.postMessage({type:'snapshot'}));
function esc(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML}
function fmtT(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n))}
function fmtTime(ts){return new Date(ts).toTimeString().slice(0,8)}
function addRow(call){
  if(els.feedEmpty) els.feedEmpty.style.display='none';
  const r=document.createElement('div');r.className='feed-row';
  r.innerHTML='<span class="feed-time">'+fmtTime(call.ts)+'</span><span class="feed-tool'+(call.denied?' bad':'')+'">'+esc(call.denied?'DENIED · '+call.tool:call.tool)+'</span><span class="feed-client">'+esc(call.client)+'</span><span class="feed-meta">'+call.ms+'ms · ~'+fmtT(call.estTokens)+'</span>';
  // reorder grid: time tool client meta -> use 4 cols visually but keep 3 col grid with client+meta? keep simple 4
  r.style.gridTemplateColumns='64px 1fr 1fr auto';
  els.feed.prepend(r);while(els.feed.children.length>80) els.feed.lastChild.remove();
}
function addBlocked(m){
  if(els.feedEmpty) els.feedEmpty.style.display='none';
  const r=document.createElement('div');r.className='feed-row';
  r.innerHTML='<span class="feed-time">'+fmtTime(m.ts)+'</span><span class="feed-tool bad">⛔ '+esc(m.kind)+'</span><span class="feed-client">'+esc(m.detail).slice(0,90)+'</span><span class="feed-meta">blocked</span>';
  r.style.gridTemplateColumns='64px 1fr 1fr auto';
  els.feed.prepend(r);
}
let counters={calls:0,tokens:0,denied:0};
function bump(call){
  counters.calls++;counters.tokens+=call.estTokens;if(call.denied) counters.denied++;
  els.kCalls.textContent=String(counters.calls);els.kTokens.innerHTML=fmtT(counters.tokens)+' <small>~chars / 4</small>';els.kDenied.textContent=String(counters.denied);
  els.kCallsHint.textContent=counters.calls===1?'1 call':counters.calls+' calls';
}
window.addEventListener('message',ev=>{
  const m=ev.data;
  if(m.type==='call'){addRow(m.call);bump(m.call)}
  else if(m.type==='blocked'){addBlocked(m)}
  else if(m.type==='audit'){addBlocked({ts:m.event.ts,kind:m.event.kind,detail:m.event.detail})}
  else if(m.type==='snapshot') render(m);
});
function render(m){
  counters={calls:m.totals.calls,tokens:m.totals.tokens,denied:m.totals.denied};
  els.kCalls.textContent=String(counters.calls);els.kTokens.innerHTML=fmtT(counters.tokens)+' <small>~chars / 4</small>';els.kDenied.textContent=String(counters.denied);
  els.kCallsHint.textContent=counters.calls?counters.calls+' calls':'No activity yet';
  els.clientsCount.textContent=String(m.clients.length);
  if(m.clients.length){els.clientsEmpty.style.display='none';els.clientsBody.innerHTML=m.clients.map(c=>{
    const cls=c.preset==='Standard'?'ok':c.preset==='Full access'?'warn':'';
    return '<tr><td><strong>'+esc(c.label)+'</strong></td><td><span class="badge '+cls+'">'+esc(c.preset)+'</span></td><td class="num">'+c.calls+'</td><td class="num" style="'+(c.denied?'color:#dc2626':'')+'">'+(c.denied||0)+'</td><td class="num">~'+fmtT(c.estTokens)+'</td></tr>';
  }).join('')} else {els.clientsEmpty.style.display='block';els.clientsBody.innerHTML=''}
  if(m.totals.topTools.length){els.topEmpty.style.display='none';const max=Math.max(1,m.totals.topTools[0].tokens);els.topTools.innerHTML=m.totals.topTools.map(t=>'<div class="rank-row"><span class="rank-name">'+esc(t.tool)+'</span><span class="rank-meta">~'+fmtT(t.tokens)+'</span><span class="rank-meta">'+t.calls+'×</span><span class="rank-bar"><span class="rank-fill" style="width:'+Math.max(6,t.tokens/max*100)+'%"></span></span></div>').join('')} else {els.topEmpty.style.display='block';els.topTools.innerHTML=''}
}
vsapi.postMessage({type:'snapshot'});
</script>
</body></html>`;
    }
}
