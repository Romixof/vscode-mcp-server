import * as vscode from 'vscode';
export interface DashboardClientInfo { clientId: string; label: string; preset: string; calls: number; denied: number; lastSeen: number; estTokens: number; }
interface ToolUsageEntry { tool: string; client: string; ts: number; ms: number; estTokens: number; denied: boolean; }
interface BlockEntry { ts: number; kind: string; detail: string; }
let panelRef: Dashboard | undefined;
export function setDashboardRef(d: Dashboard): void { panelRef = d; }
export function notifyDashboard(event: { ts: number; kind: string; client: string; detail: string }): void { try { panelRef?.pushLiveExternal({ type: 'audit', event }); } catch {} }
export function estimateTokens(result: unknown): number { try { let len = 0; const obj = result as { content?: Array<{ type?: string; text?: string }> }; if (obj && Array.isArray(obj.content)) for (const c of obj.content) if (typeof c?.text === 'string') len += c.text.length; return Math.ceil(len / 4); } catch { return 0; } }
export class Dashboard {
    private panel?: vscode.WebviewPanel;
    private usage: ToolUsageEntry[] = [];
    private clients = new Map<string, DashboardClientInfo>();
    private blocks: BlockEntry[] = [];
    private audits: Array<{ ts: number; kind: string; client: string; detail: string }> = [];
    private paused = false;
    private buckets: number[] = Array(60).fill(0);
    private bucketMinute = Math.floor(Date.now() / 60000);
    private latMap = new Map<string, number[]>();
    setClientPreset(clientId: string, preset: string): void { const info = this.clients.get(clientId); if (info) info.preset = preset; else this.clients.set(clientId, { clientId, label: clientId, preset, calls: 0, denied: 0, lastSeen: 0, estTokens: 0 }); }
    recordToolCall(tool: string, client: string, ms: number, estTokens: number, denied: boolean): void {
        const ts = Date.now();
        this.usage.push({ tool, client, ts, ms, estTokens, denied });
        if (this.usage.length > 2000) this.usage = this.usage.slice(-1500);
        const info = this.clients.get(client) ?? { clientId: client, label: client, preset: '—', calls: 0, denied: 0, lastSeen: 0, estTokens: 0 };
        info.calls += 1; if (denied) info.denied += 1; info.estTokens += estTokens; info.lastSeen = ts; this.clients.set(client, info);
        const m = Math.floor(ts / 60000);
        if (m !== this.bucketMinute) { const diff = Math.min(60, m - this.bucketMinute); for (let i = 0; i < diff; i++) this.buckets.shift(), this.buckets.push(0); this.bucketMinute = m; }
        this.buckets[59] += 1;
        const arr = this.latMap.get(tool) ?? []; arr.push(ms); if (arr.length > 80) arr.shift(); this.latMap.set(tool, arr);
        this.pushLive({ type: 'call', call: { tool, client, ms, estTokens, denied, ts } });
        this.pushLive({ type: 'spark', buckets: this.buckets });
    }
    recordBlocked(kind: string, detail: string): void { const e: BlockEntry = { ts: Date.now(), kind, detail }; this.blocks.unshift(e); if (this.blocks.length > 80) this.blocks.pop(); this.pushLive({ type: 'blocked', ...e }); }
    pushLiveExternal(msg: unknown): void {
        const m = msg as { type?: string; event?: { ts: number; kind: string; client: string; detail: string } };
        if (m.type === 'audit' && m.event) { this.audits.unshift(m.event); if (this.audits.length > 200) this.audits.pop(); this.pushLive({ type: 'audit', event: m.event }); }
        else this.pushLive(msg);
    }
    show(context: vscode.ExtensionContext): void {
        if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
        const panel = vscode.window.createWebviewPanel('mcpDashboard', 'MCP Server', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        this.panel = panel;
        panel.onDidDispose(() => { this.panel = undefined; }, null, context.subscriptions);
        panel.webview.onDidReceiveMessage(msg => this.onMessage(msg, context));
        panel.webview.html = this.renderHtml();
        try { const { getRecentAudit } = require('./auth/audit'); const recent = getRecentAudit(80) as Array<{ ts: number; kind: string; client: string; detail: string }>; this.audits = recent.slice().reverse(); } catch {}
        this.sendSnapshot();
        this.pushLive({ type: 'spark', buckets: this.buckets });
    }
    private onMessage(msg: { type?: string; pause?: boolean; clientId?: string }, context: vscode.ExtensionContext): void {
        switch (msg.type) {
            case 'snapshot': this.sendSnapshot(); this.pushLive({ type: 'spark', buckets: this.buckets }); break;
            case 'pause': this.paused = Boolean(msg.pause); break;
            case 'clear': this.usage = []; this.clients.clear(); this.blocks = []; this.audits = []; this.buckets = Array(60).fill(0); this.latMap.clear(); this.sendSnapshot(); this.pushLive({ type: 'spark', buckets: this.buckets }); break;
            case 'revoke': {
                const id = String(msg.clientId || ''); if (!id) break;
                try { const { revokeClient } = require('./auth-oauth'); revokeClient(id); } catch {}
                try { const { appendAudit } = require('./auth/audit'); appendAudit({ kind: 'token_revoked', client: 'dashboard', detail: id }); } catch {}
                this.audits.unshift({ ts: Date.now(), kind: 'token_revoked', client: 'dashboard', detail: id }); if (this.audits.length > 200) this.audits.pop();
                this.pushLive({ type: 'revoked', clientId: id });
                this.sendSnapshot();
                vscode.window.showInformationMessage(`Revoked ${id}`);
                break;
            }
            case 'exportAudit': {
                const payload = JSON.stringify(this.audits.slice().reverse(), null, 2);
                const uri = vscode.Uri.parse('untitled:' + `mcp-audit-${Date.now()}.json`);
                vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc).then(ed => ed.edit(b => b.insert(new vscode.Position(0, 0), payload))));
                break;
            }
        }
    }
    private getConfigSnapshot() {
        const cfg = vscode.workspace.getConfiguration('vscode-mcp-server');
        return { sandboxMode: cfg.get<string>('security.sandbox.mode', 'workspace'), port: cfg.get<number>('port', 3000), host: cfg.get<string>('host', '127.0.0.1') };
    }
    private getLatencySnapshot() {
        let total = 0, n = 0;
        for (const arr of this.latMap.values()) for (const v of arr) total += v, n++;
        const avg = n ? Math.round(total / n) : 0;
        const all = ([] as number[]).concat(...[...this.latMap.values()]); all.sort((a, b) => a - b);
        const p95 = all.length ? all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] : 0;
        const perTool: Array<{ tool: string; avg: number; p95: number; n: number }> = [];
        for (const [tool, arr] of this.latMap) { const s = [...arr].sort((a, b) => a - b); const a = Math.round(arr.reduce((x, y) => x + y, 0) / arr.length); perTool.push({ tool, avg: a, p95: s[Math.floor(s.length * 0.95)] ?? a, n: arr.length }); }
        perTool.sort((a, b) => b.avg - a.avg);
        return { avg, p95, perTool: perTool.slice(0, 6) };
    }
    private sendSnapshot(): void {
        if (!this.panel) return;
        const totalTokens = this.usage.reduce((a, u) => a + u.estTokens, 0);
        const byTool = new Map<string, { calls: number; tokens: number }>();
        for (const u of this.usage) { const e = byTool.get(u.tool) ?? { calls: 0, tokens: 0 }; e.calls += 1; e.tokens += u.estTokens; byTool.set(u.tool, e); }
        const topTools = [...byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6).map(([tool, v]) => ({ tool, ...v }));
        this.panel.webview.postMessage({ type: 'snapshot', clients: [...this.clients.values()], totals: { calls: this.usage.length, tokens: totalTokens, denied: this.usage.filter(u => u.denied).length, topTools }, config: this.getConfigSnapshot(), latency: this.getLatencySnapshot(), blocks: this.blocks.slice(0, 30), audits: this.audits.slice(0, 40) }).then(() => undefined, () => undefined);
    }
    private pushLive(msg: unknown): void { if (!this.paused && this.panel) this.panel.webview.postMessage(msg).then(() => undefined, () => undefined); }
    private renderHtml(): string {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--border:var(--vscode-widget-border,var(--vscode-panel-border,#e5e7eb));--muted:var(--vscode-descriptionForeground,#6b7280);--accent:var(--vscode-textLink-foreground,#0ea5e9)}
body{font-family:var(--vscode-font-family,Inter,system-ui,-apple-system,sans-serif);font-size:13px;line-height:1.5;color:var(--vscode-foreground);background:var(--vscode-editor-background);-webkit-font-smoothing:antialiased}
.header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:10;flex-wrap:wrap}
.header h1{font-size:13px;font-weight:600;letter-spacing:-.01em}
.header h1 span{font-weight:400;color:var(--muted)}
.hdr-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.live{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}
.live i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.live.paused i{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.btn{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--vscode-button-secondaryBackground,var(--vscode-editor-background));color:var(--vscode-foreground);cursor:pointer}
.btn:hover{background:var(--vscode-list-hoverBackground)}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn.small{padding:4px 8px;font-size:11px;border-radius:6px}
.wrap{max-width:1040px;margin:0 auto;padding:16px 20px 24px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
@media(max-width:640px){.stats{grid-template-columns:1fr}}
.card{background:var(--vscode-sideBar-background,var(--vscode-editor-background));border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.card-label{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.card-value{font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1}
.card-value small{font-size:11px;font-weight:400;color:var(--muted);margin-left:4px}
.card-hint{font-size:12px;color:var(--muted);margin-top:4px}
.spark-wrap{padding:10px 14px}
.spark-wrap svg{width:100%;height:36px;display:block}
.grid{display:grid;grid-template-columns:1.4fr .9fr;gap:12px;margin-bottom:12px}
@media(max-width:780px){.grid{grid-template-columns:1fr}}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:780px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--vscode-sideBar-background,var(--vscode-editor-background));border:1px solid var(--border);border-radius:12px;overflow:hidden}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border)}
.panel-title{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.count{font-size:11px;color:var(--muted);background:var(--vscode-badge-background,rgba(0,0,0,.06));padding:2px 8px;border-radius:999px;white-space:nowrap}
.table{width:100%;border-collapse:collapse}
.table th{font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border)}
.table td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px}
.table tr:last-child td{border-bottom:none}
.badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.badge.ok{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.2);color:#15803d}
.badge.warn{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.2);color:#92400e}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.rank{padding:6px 14px}
.rank-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)}
.rank-row:last-child{border-bottom:none}
.rank-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.rank-bar{width:64px;height:5px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden;flex-shrink:0}
.rank-fill{height:100%;background:var(--accent);border-radius:999px}
.rank-meta{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.filter-bar{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.filter-bar input,.filter-bar select{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);min-width:140px}
.filter-bar label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer}
.feed{max-height:320px;overflow:auto}
.feed-row{display:grid;grid-template-columns:64px 1fr 1fr auto;gap:8px;align-items:center;padding:7px 14px;border-bottom:1px solid var(--border);font-size:12px}
.feed-row:last-child{border-bottom:none}
.feed-time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11px}
.feed-tool{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-tool.bad{color:#dc2626}
.feed-client{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-meta{color:var(--muted);font-size:11px;white-space:nowrap}
.mini-list{max-height:220px;overflow:auto}
.mini-row{padding:7px 14px;border-bottom:1px solid var(--border);font-size:12px;display:flex;gap:8px;align-items:center}
.mini-row:last-child{border-bottom:none}
.mini-time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11px;min-width:64px}
.mini-kind{font-weight:600;white-space:nowrap}
.mini-detail{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.empty{padding:20px 16px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
.empty strong{color:var(--vscode-foreground);font-weight:600}
.alert{margin:0 14px 10px;padding:8px 12px;border-radius:8px;border:1px solid rgba(239,68,68,.25);background:rgba(239,68,68,.08);color:#991b1b;font-size:12px;display:none}
.config-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:12px 14px}
@media(max-width:640px){.config-grid{grid-template-columns:1fr}}
.cfg{font-size:12px}
.cfg label{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.cfg div{margin-top:2px;font-variant-numeric:tabular-nums}
</style></head>
<body>
<header class="header">
  <h1>MCP Server <span>— Dashboard</span></h1>
  <div class="hdr-right">
    <span class="live" id="livePill"><i></i><span id="liveText">Live</span></span>
    <button class="btn" id="pauseBtn">Pause</button>
    <button class="btn" id="clearBtn">Clear</button>
    <button class="btn primary" id="refreshBtn">Refresh</button>
  </div>
</header>
<div class="wrap">
  <section class="stats">
    <div class="card"><div class="card-label">Total calls</div><div class="card-value" id="kCalls">0</div><div class="card-hint" id="kCallsHint">No activity yet · <span id="kLatency">— ms avg</span></div></div>
    <div class="card"><div class="card-label">Estimated tokens</div><div class="card-value" id="kTokens">0 <small>~chars / 4</small></div><div class="card-hint" id="kTokensHint">Across all clients</div></div>
    <div class="card"><div class="card-label">Denied / blocked</div><div class="card-value" id="kDenied">0</div><div class="card-hint" id="kDeniedHint">Policy enforcements</div></div>
  </section>
  <section class="panel" style="margin-bottom:12px">
    <div class="panel-head"><span class="panel-title">Calls — last hour</span><span class="count" id="sparkCount">60 min</span></div>
    <div class="spark-wrap"><svg id="sparkSvg" viewBox="0 0 60 36" preserveAspectRatio="none"><polyline id="sparkLine" fill="none" stroke="var(--vscode-textLink-foreground,#0ea5e9)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" points=""/><polyline id="sparkFill" fill="rgba(14,165,233,.08)" stroke="none" points=""/></svg></div>
  </section>
  <div class="grid">
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Clients</span><span class="count" id="clientsCount">0</span></div>
      <table class="table"><thead><tr><th>Client</th><th>Preset</th><th style="text-align:right">Calls</th><th style="text-align:right">Denied</th><th style="text-align:right">Tokens</th><th></th></tr></thead><tbody id="clientsBody"></tbody></table>
      <div class="empty" id="clientsEmpty"><strong>No client connected yet.</strong><br>Open Mammouth or Claude — it appears here instantly.</div>
    </section>
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Top tools</span><span class="count">by tokens · latency</span></div>
      <div class="rank" id="topTools"></div>
      <div class="empty" id="topEmpty">No data yet — run a tool to see ranking.</div>
      <div class="panel-head" style="border-top:1px solid var(--border)"><span class="panel-title">Slowest tools</span><span class="count">avg / p95</span></div>
      <div class="rank" id="slowTools"></div>
    </section>
  </div>
  <section class="panel" style="margin-bottom:12px">
    <div class="panel-head"><span class="panel-title">Live activity</span><span class="count" id="feedCount">0</span></div>
    <div class="filter-bar">
      <input id="fSearch" placeholder="Filter tool or client…">
      <select id="fTool"><option value="">All tools</option></select>
      <label><input type="checkbox" id="fDenied"> Denied only</label>
      <span style="flex:1"></span><button class="btn small" id="fClear">Clear filters</button>
    </div>
    <div class="alert" id="burstAlert">Burst of denials — check scopes for this client.</div>
    <div class="feed" id="feed" role="log" aria-live="polite"></div>
    <div class="empty" id="feedEmpty"><strong>Waiting for activity…</strong><br>Every tool call appears here in real time.</div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Security — blocked</span><span class="count" id="blocksCount">0</span></div>
      <div class="mini-list" id="blocksList"></div>
      <div class="empty" id="blocksEmpty">No blocks yet.</div>
    </section>
    <section class="panel">
      <div class="panel-head"><span class="panel-title">Audit log</span><div style="display:flex;gap:6px;align-items:center"><span class="count" id="auditsCount">0</span><button class="btn small" id="exportBtn">Export</button></div></div>
      <div class="mini-list" id="auditsList"></div>
      <div class="empty" id="auditsEmpty">No audit events yet.</div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-head"><span class="panel-title">Config & cluster</span></div>
    <div class="config-grid">
      <div class="cfg"><label>Sandbox</label><div id="cfgSandbox">—</div></div>
      <div class="cfg"><label>Server</label><div id="cfgServer">—</div></div>
      <div class="cfg"><label>Port / host</label><div id="cfgPort">—</div></div>
    </div>
  </section>
</div>
<script>
const vsapi=acquireVsCodeApi();
let paused=false;
let allRows=[];
let filters={q:'',tool:'',denied:false};
const els={
  pauseBtn:document.getElementById('pauseBtn'),livePill:document.getElementById('livePill'),liveText:document.getElementById('liveText'),
  kCalls:document.getElementById('kCalls'),kTokens:document.getElementById('kTokens'),kDenied:document.getElementById('kDenied'),
  kCallsHint:document.getElementById('kCallsHint'),kLatency:document.getElementById('kLatency'),kDeniedHint:document.getElementById('kDeniedHint'),
  clientsBody:document.getElementById('clientsBody'),clientsEmpty:document.getElementById('clientsEmpty'),clientsCount:document.getElementById('clientsCount'),
  topTools:document.getElementById('topTools'),topEmpty:document.getElementById('topEmpty'),slowTools:document.getElementById('slowTools'),
  feed:document.getElementById('feed'),feedEmpty:document.getElementById('feedEmpty'),feedCount:document.getElementById('feedCount'),
  fSearch:document.getElementById('fSearch'),fTool:document.getElementById('fTool'),fDenied:document.getElementById('fDenied'),
  sparkLine:document.getElementById('sparkLine'),sparkFill:document.getElementById('sparkFill'),
  blocksList:document.getElementById('blocksList'),blocksEmpty:document.getElementById('blocksEmpty'),blocksCount:document.getElementById('blocksCount'),
  auditsList:document.getElementById('auditsList'),auditsEmpty:document.getElementById('auditsEmpty'),auditsCount:document.getElementById('auditsCount'),
  burstAlert:document.getElementById('burstAlert'),
  cfgSandbox:document.getElementById('cfgSandbox'),cfgServer:document.getElementById('cfgServer'),cfgPort:document.getElementById('cfgPort'),
};
function setPaused(v){paused=v;els.pauseBtn.textContent=paused?'Resume':'Pause';els.livePill.classList.toggle('paused',paused);els.liveText.textContent=paused?'Paused':'Live';vsapi.postMessage({type:'pause',pause:paused})}
els.pauseBtn.addEventListener('click',()=>setPaused(!paused));
document.getElementById('clearBtn').addEventListener('click',()=>vsapi.postMessage({type:'clear'}));
document.getElementById('refreshBtn').addEventListener('click',()=>vsapi.postMessage({type:'snapshot'}));
document.getElementById('exportBtn').addEventListener('click',()=>vsapi.postMessage({type:'exportAudit'}));
document.getElementById('fClear').addEventListener('click',()=>{els.fSearch.value='';els.fTool.value='';els.fDenied.checked=false;filters={q:'',tool:'',denied:false};renderFeed()});
els.fSearch.addEventListener('input',()=>{filters.q=els.fSearch.value.toLowerCase().trim();renderFeed()});
els.fTool.addEventListener('change',()=>{filters.tool=els.fTool.value;renderFeed()});
els.fDenied.addEventListener('change',()=>{filters.denied=els.fDenied.checked;renderFeed()});
function esc(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML}
function fmtT(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n))}
function fmtTime(ts){return new Date(ts).toTimeString().slice(0,8)}
function drawSpark(arr){
  const max=Math.max(1,...arr);const pts=arr.map((v,i)=> (i/(arr.length-1)*60).toFixed(1)+','+(36 - (v/max*28) - 4).toFixed(1)).join(' ');
  els.sparkLine.setAttribute('points',pts);
  const fillPts='0,36 '+pts+' 60,36'; els.sparkFill.setAttribute('points',fillPts);
}
function addFeedItem(call){
  allRows.unshift(call); if(allRows.length>400) allRows.pop();
  const toolSet=new Set(allRows.map(r=>r.tool)); const cur=els.fTool.value;
  els.fTool.innerHTML='<option value="">All tools</option>'+[...toolSet].sort().map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join('');
  if(cur) els.fTool.value=cur;
  renderFeed();
  const recentDenied=allRows.slice(0,8).filter(r=>r.denied).length; els.burstAlert.style.display=recentDenied>=4?'block':'none';
}
function renderFeed(){
  const q=filters.q, tool=filters.tool, denied=filters.denied;
  const filtered=allRows.filter(r=>{
    if(denied && !r.denied) return false;
    if(tool && r.tool!==tool) return false;
    if(q && !(r.tool.toLowerCase().includes(q) || r.client.toLowerCase().includes(q))) return false;
    return true;
  });
  els.feedCount.textContent=filtered.length+' / '+allRows.length;
  if(!filtered.length){els.feed.innerHTML='';els.feedEmpty.style.display='block';els.feedEmpty.innerHTML=q||tool||denied?'<strong>No matches.</strong><br>Adjust filters.':'<strong>Waiting for activity…</strong><br>Every tool call appears here in real time.';return}
  els.feedEmpty.style.display='none';
  els.feed.innerHTML=filtered.slice(0,80).map(r=>'<div class="feed-row"><span class="feed-time">'+fmtTime(r.ts)+'</span><span class="feed-tool'+(r.denied?' bad':'')+'">'+esc(r.denied?'DENIED · '+r.tool:r.tool)+'</span><span class="feed-client">'+esc(r.client)+'</span><span class="feed-meta">'+r.ms+'ms · ~'+fmtT(r.estTokens)+'</span></div>').join('');
}
let counters={calls:0,tokens:0,denied:0};
function bump(call){counters.calls++;counters.tokens+=call.estTokens;if(call.denied) counters.denied++; els.kCalls.textContent=String(counters.calls);els.kTokens.innerHTML=fmtT(counters.tokens)+' <small>~chars / 4</small>';els.kDenied.textContent=String(counters.denied); els.kCallsHint.innerHTML=counters.calls+' calls · <span id="kLatency">'+(els.kLatency.textContent)+'</span>';}
window.addEventListener('message',ev=>{
  const m=ev.data;
  if(m.type==='call'){addFeedItem(m.call);bump(m.call)}
  else if(m.type==='blocked'){addBlock(m); addAudit({ts:m.ts,kind:m.kind,client:'—',detail:m.detail})}
  else if(m.type==='audit'){addAudit(m.event)}
  else if(m.type==='revoked'){addAudit({ts:Date.now(),kind:'token_revoked',client:'dashboard',detail:m.clientId})}
  else if(m.type==='spark'){drawSpark(m.buckets)}
  else if(m.type==='snapshot') renderSnapshot(m);
});
function addBlock(b){
  const id='blocksList';
  document.getElementById('blocksEmpty').style.display='none';
  document.getElementById('blocksCount').textContent=String((parseInt(document.getElementById('blocksCount').textContent||'0')+1));
  const row=document.createElement('div');row.className='mini-row';
  row.innerHTML='<span class="mini-time">'+fmtTime(b.ts)+'</span><span class="mini-kind" style="color:#dc2626">'+esc(b.kind)+'</span><span class="mini-detail">'+esc(b.detail).slice(0,100)+'</span>';
  document.getElementById('blocksList').prepend(row);
}
function addAudit(ev){
  document.getElementById('auditsEmpty').style.display='none';
  const c=document.getElementById('auditsCount'); c.textContent=String(parseInt(c.textContent||'0')+1);
  const row=document.createElement('div');row.className='mini-row';
  const col=ev.kind==='token_revoked'?'#991b1b':ev.kind==='tool_denied'||ev.kind==='shell_blocked'?'#dc2626':'#6b7280';
  row.innerHTML='<span class="mini-time">'+fmtTime(ev.ts)+'</span><span class="mini-kind" style="color:'+col+'">'+esc(ev.kind)+'</span><span class="mini-detail">'+esc(ev.client)+' · '+esc(ev.detail).slice(0,90)+'</span>';
  document.getElementById('auditsList').prepend(row);
  while(document.getElementById('auditsList').children.length>40) document.getElementById('auditsList').lastChild.remove();
}
function renderSnapshot(m){
  counters={calls:m.totals.calls,tokens:m.totals.tokens,denied:m.totals.denied};
  els.kCalls.textContent=String(counters.calls);els.kTokens.innerHTML=fmtT(counters.tokens)+' <small>~chars / 4</small>';els.kDenied.textContent=String(counters.denied);
  els.kCallsHint.innerHTML=counters.calls?counters.calls+' calls':'No activity yet';
  if(m.latency){els.kLatency.textContent=m.latency.avg?m.latency.avg+'ms avg · '+m.latency.p95+'ms p95':'— ms avg'; const hint=document.getElementById('kLatency'); if(hint) hint.textContent=els.kLatency.textContent}
  els.clientsCount.textContent=String(m.clients.length);
  if(m.clients.length){els.clientsEmpty.style.display='none';els.clientsBody.innerHTML=m.clients.map(c=>{
    const cls=c.preset==='Standard'?'ok':c.preset==='Full access'?'warn':''; 
    return '<tr><td><strong>'+esc(c.label)+'</strong></td><td><span class="badge '+cls+'">'+esc(c.preset)+'</span></td><td class="num">'+c.calls+'</td><td class="num" style="'+(c.denied?'color:#dc2626':'')+'">'+(c.denied||0)+'</td><td class="num">~'+fmtT(c.estTokens)+'</td><td><button class="btn small" onclick="vsapi.postMessage({type:\\'revoke\\',clientId:'+JSON.stringify(c.clientId)+'})">Revoke</button></td></tr>';
  }).join('')} else {els.clientsEmpty.style.display='block';els.clientsBody.innerHTML=''}
  if(m.totals.topTools.length){document.getElementById('topEmpty').style.display='none';const max=Math.max(1,m.totals.topTools[0].tokens);els.topTools.innerHTML=m.totals.topTools.map(t=>'<div class="rank-row"><span class="rank-name">'+esc(t.tool)+'</span><span class="rank-meta">~'+fmtT(t.tokens)+'</span><span class="rank-meta">'+t.calls+'×</span><span class="rank-bar"><span class="rank-fill" style="width:'+Math.max(6,t.tokens/max*100)+'%"></span></span></div>').join('')} else {document.getElementById('topEmpty').style.display='block';els.topTools.innerHTML=''}
  const slow=document.getElementById('slowTools'); if(m.latency && m.latency.perTool.length){slow.innerHTML=m.latency.perTool.map(p=>'<div class="rank-row"><span class="rank-name">'+esc(p.tool)+'</span><span class="rank-meta">'+p.avg+'ms</span><span class="rank-meta">p95 '+p.p95+'ms</span></div>').join('')} else slow.innerHTML='<div class="empty" style="padding:8px">No timing yet.</div>';
  if(m.config){els.cfgSandbox.textContent=m.config.sandboxMode; els.cfgServer.textContent=m.config.host; els.cfgPort.textContent=m.config.port}
  if(m.blocks && m.blocks.length){els.blocksEmpty.style.display='none';els.blocksCount.textContent=String(m.blocks.length);els.blocksList.innerHTML=m.blocks.map(b=>'<div class="mini-row"><span class="mini-time">'+fmtTime(b.ts)+'</span><span class="mini-kind" style="color:#dc2626">'+esc(b.kind)+'</span><span class="mini-detail">'+esc(b.detail).slice(0,100)+'</span></div>').join('')}
  if(m.audits && m.audits.length){els.auditsEmpty.style.display='none';els.auditsCount.textContent=String(m.audits.length);els.auditsList.innerHTML=m.audits.map(ev=>'<div class="mini-row"><span class="mini-time">'+fmtTime(ev.ts)+'</span><span class="mini-kind">'+esc(ev.kind)+'</span><span class="mini-detail">'+esc(ev.client)+' · '+esc(ev.detail).slice(0,90)+'</span></div>').join('')}
  allRows=m.totals.calls?allRows:[]; // keep existing rows, don't wipe on snapshot
  renderFeed();
}
vsapi.postMessage({type:'snapshot'});
</script>
</body></html>`;
    }
}
