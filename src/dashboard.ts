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

export function setDashboardRef(d: Dashboard): void {
    panelRef = d;
}

export function notifyDashboard(event: { ts: number; kind: string; client: string; detail: string }): void {
    try {
        panelRef?.pushLiveExternal({ type: 'audit', event });
    } catch {}
}

export function estimateTokens(result: unknown): number {
    try {
        let len = 0;
        const obj = result as { content?: Array<{ type?: string; text?: string }> };
        if (obj && Array.isArray(obj.content)) {
            for (const c of obj.content) if (typeof c?.text === 'string') len += c.text.length;
        }
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
        info.calls += 1;
        if (denied) info.denied += 1;
        info.estTokens += estTokens;
        info.lastSeen = Date.now();
        this.clients.set(client, info);
        this.pushLive({ type: 'call', call: { tool, client, ms, estTokens, denied, ts: Date.now() } });
    }

    recordBlocked(kind: string, detail: string): void {
        this.pushLive({ type: 'blocked', kind, detail, ts: Date.now() });
    }

    pushLiveExternal(msg: unknown): void { this.pushLive(msg); }

    private pushLive(msg: unknown): void {
        if (!this.paused && this.panel) this.panel.webview.postMessage(msg).then(() => undefined, () => undefined);
    }

    show(context: vscode.ExtensionContext): void {
        if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
        const panel = vscode.window.createWebviewPanel('mcpDashboard', 'MCP Server Dashboard', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
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
        const recent = this.usage.slice(-100);
        const totalTokens = this.usage.reduce((a, u) => a + u.estTokens, 0);
        const byTool = new Map<string, { calls: number; tokens: number }>();
        for (const u of this.usage) { const e = byTool.get(u.tool) ?? { calls: 0, tokens: 0 }; e.calls += 1; e.tokens += u.estTokens; byTool.set(u.tool, e); }
        this.panel.webview.postMessage({ type: 'snapshot', clients: [...this.clients.values()], feed: recent, totals: { calls: this.usage.length, tokens: totalTokens, denied: this.usage.filter(u => u.denied).length, topTools: [...byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 8).map(([tool, v]) => ({ tool, ...v })) } }).then(() => undefined, () => undefined);
    }

    private renderHtml(): string {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
:root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --card: var(--vscode-panel-background); --border: var(--vscode-panel-border, #333); --ok: #4ec9a6; --warn: #f4c542; --err: #f48771; --accent: #3794ff; --dim: #888; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--fg); background: var(--bg); padding: 10px; }
h1 { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
@keyframes pulse { 50% { opacity: .4; } }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px; min-height: 110px; }
.card h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin-bottom: 8px; }
.kpi { font-size: 22px; font-weight: 700; color: var(--accent); }
.kpi small { font-size: 11px; color: var(--dim); font-weight: 400; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 3px 6px; text-align: left; border-bottom: 1px solid var(--border); }
th { color: var(--dim); font-weight: 500; font-size: 11px; }
.feed { max-height: 260px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.feed .row { padding: 2px 4px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; white-space: nowrap; overflow: hidden; }
.feed .t { color: var(--dim); flex-shrink: 0; }
.feed .denied { color: var(--err); }
.feed .ok-call { color: var(--ok); }
.bar { height: 6px; background: var(--accent); border-radius: 3px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 600; }
.b-red { background: rgba(244,135,113,.15); color: var(--err); }
.b-blue { background: rgba(55,148,255,.15); color: var(--accent); }
.toolbar { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
button { background: var(--accent); color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
button.ghost { background: transparent; border: 1px solid var(--border); color: var(--fg); }
#pausedBadge { display: none; }
.empty { color: var(--dim); font-style: italic; padding: 14px; text-align: center; }
</style></head>
<body>
<h1><span class="dot"></span> MCP Server Dashboard <span id="pausedBadge" class="badge b-red">PAUSED</span></h1>
<div class="grid3">
  <div class="card"><h2>Total calls</h2><div class="kpi" id="kCalls">0</div></div>
  <div class="card"><h2>Est. tokens</h2><div class="kpi" id="kTokens">0 <small>~chars/4</small></div></div>
  <div class="card"><h2>Denied / blocked</h2><div class="kpi" id="kDenied">0</div></div>
</div>
<div class="grid">
  <div class="card">
    <h2>Clients</h2>
    <table><thead><tr><th>Client</th><th>Preset</th><th>Calls</th><th>Denied</th><th>Tokens</th></tr></thead>
    <tbody id="clientsBody"><tr><td colspan="5" class="empty">No client yet.</td></tr></tbody></table>
  </div>
  <div class="card"><h2>Top tools by tokens</h2><div id="topTools" class="empty">No data yet.</div></div>
</div>
<br>
<div class="card">
  <div class="toolbar"><h2 style="margin:0">Live activity</h2><button id="pauseBtn" class="ghost">Pause</button><button id="clearBtn" class="ghost">Clear</button><button id="refreshBtn">Refresh</button></div>
  <div id="feed" class="feed"><div class="empty">Waiting for activity…</div></div>
</div>
<script>
const vsapi = acquireVsCodeApi();
let paused = false;
document.getElementById('pauseBtn').addEventListener('click', () => { paused = !paused; document.getElementById('pauseBtn').textContent = paused ? 'Resume' : 'Pause'; document.getElementById('pausedBadge').style.display = paused ? 'inline-block' : 'none'; vsapi.postMessage({ type: 'pause', pause: paused }); });
document.getElementById('clearBtn').addEventListener('click', () => vsapi.postMessage({ type: 'clear' }));
document.getElementById('refreshBtn').addEventListener('click', () => vsapi.postMessage({ type: 'snapshot' }));
function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
function fmtT(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n)); }
function fmtTime(ts) { const d = new Date(ts); return d.toTimeString().slice(0,8); }
function addFeedRow(call) {
    const feed = document.getElementById('feed'); const empty = feed.querySelector('.empty'); if (empty) empty.remove();
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<span class="t">'+fmtTime(call.ts)+'</span> <span class="'+(call.denied?'denied':'ok-call')+'">'+esc(call.denied?'DENIED':call.tool)+'</span> <span>'+esc(call.client)+'</span> <span style="margin-left:auto;color:var(--dim)">'+call.ms+'ms · ~'+fmtT(call.estTokens)+' tok</span>';
    feed.prepend(row); while (feed.children.length > 120) feed.lastChild.remove();
}
window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'call') { addFeedRow(m.call); refreshCounters(m.call); }
    if (m.type === 'blocked') { const feed = document.getElementById('feed'); const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span class="t">'+fmtTime(m.ts)+'</span><span class="denied">⛔ '+esc(m.kind)+'</span><span>'+esc(m.detail).slice(0,90)+'</span>'; feed.prepend(row); }
    if (m.type === 'snapshot') renderSnapshot(m);
});
let counters = { calls: 0, tokens: 0, denied: 0 };
function refreshCounters(call) { counters.calls++; counters.tokens += call.estTokens; if (call.denied) counters.denied++; document.getElementById('kCalls').textContent = counters.calls; document.getElementById('kTokens').innerHTML = fmtT(counters.tokens)+' <small>~chars/4</small>'; document.getElementById('kDenied').textContent = counters.denied; }
function renderSnapshot(m) {
    counters = { calls: m.totals.calls, tokens: m.totals.tokens, denied: m.totals.denied };
    document.getElementById('kCalls').textContent = counters.calls; document.getElementById('kTokens').innerHTML = fmtT(counters.tokens)+' <small>~chars/4</small>'; document.getElementById('kDenied').textContent = counters.denied;
    const cb = document.getElementById('clientsBody');
    cb.innerHTML = m.clients.length ? m.clients.map(c => '<tr><td><strong>'+esc(c.label)+'</strong></td><td><span class="badge b-blue">'+esc(c.preset)+'</span></td><td>'+c.calls+'</td><td>'+(c.denied>0?'<span class="badge b-red">'+c.denied+'</span>':'0')+'</td><td>~'+fmtT(c.estTokens)+'</td></tr>').join('') : '<tr><td colspan="5" class="empty">No client yet.</td></tr>';
    const tt = document.getElementById('topTools');
    tt.innerHTML = m.totals.topTools.length ? m.totals.topTools.map(t => '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><div style="width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(t.tool)+'</div><div style="flex:1;background:var(--border);border-radius:3px;height:6px"><div class="bar" style="width:'+Math.max(3,t.tokens/Math.max(1,m.totals.topTools[0].tokens)*100)+'%"></div></div><div style="color:var(--dim);min-width:70px;text-align:right">~'+fmtT(t.tokens)+' · '+t.calls+'x</div></div>').join('') : '<div class="empty">No data yet.</div>';
}
vsapi.postMessage({ type: 'snapshot' });
</script>
</body></html>`;
    }
}
