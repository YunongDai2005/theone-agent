/**
 * 系统卡片：盒子健康、CPU/内存/存储/电池、服务、微信链路、网络、能耗、AI 额度。
 * 机器数据来自面板后端 aibox-dashboard.py 的 /api/status（它读 /proc、systemctl），额度读 ~/.aibox/quota.json。
 */
import { cfg, paths } from '../core/config.mjs';
import { readJson, readJsonl } from '../core/store.mjs';
import path from 'node:path';
import { ago, short } from '../observe/fmt.mjs';
import { quotaSnapshot, refreshQuota as refreshQuotaCache, reservations } from '../core/quota-runtime.mjs';
import { assess, windowView } from '../core/quota-policy.mjs';

// 机器状态来自面板后端的 /api/status，它现跑一轮系统命令，要 ~1 秒。
// 所以这里"先给旧的、后台刷新"（stale-while-revalidate）：只有第一次要等，之后面板永远不等它。
let cache = { at: 0, data: null }, inflight = null;
function refresh() {
  if (!inflight) {
    inflight = fetch(cfg.systemStatusUrl || 'http://127.0.0.1/api/status', { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((d) => { cache = { at: Date.now(), data: d }; })
      .catch(() => {}).finally(() => { inflight = null; });
  }
  return inflight;
}
async function status() {
  if (!cache.data) await refresh();
  else if (Date.now() - cache.at > 4000) refresh();          // 不 await：先用旧的
  if (!cache.data || Date.now() - cache.at > 120000) throw new Error('读不到机器状态');
  return cache.data;
}
const lvUsed = (p) => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'good');
const lvLeft = (p) => (p <= 10 ? 'bad' : p <= 25 ? 'warn' : 'good');
const WX = { 'wx-router': '网关', 'openclaw-gateway': 'OpenClaw', 'aibox-ollama-tunnel': '本地模型', 'aibox-quota.timer': '额度计量' };

function problems(d) {
  const out = [];
  const U = (d.wxlink || {}).units || {};
  for (const u of ['wx-router', 'openclaw-gateway', 'aibox-quota.timer']) if (U[u] !== 'active') out.push(WX[u]);
  const c = d.chatlink || {};
  if (c.astrbot !== 'active') out.push('AstrBot');
  if (c.wecom !== 'connected') out.push('企微连接');
  for (const s of d.services || []) if (!s.active) out.push(s.name);
  for (const p of (d.disk && d.disk.pools) || []) if (p.health !== 'ONLINE') out.push('ZFS ' + p.name);
  return out;
}
// 最紧的窗口重置时间（兼容工具）
function tightReset(o) {
  if (!o || !o.windows) return null;
  const ws = Object.entries(o.windows).filter(([, w]) => w && w.usedPercent != null && w.resetsAt && Date.parse(w.resetsAt) > Date.now());
  if (!ws.length) return null;
  ws.sort((a, b) => a[1].usedPercent === b[1].usedPercent ? Date.parse(a[1].resetsAt) - Date.parse(b[1].resetsAt) : b[1].usedPercent - a[1].usedPercent);
  return { at: Date.parse(ws[0][1].resetsAt), win: ws[0][0] };
}
// 时间已过只代表需要确认；不把未确认的额度显示为100%。
const winLeft = (w) => windowView(w)?.left ?? null;
// ---- 上一次调用花了多少（每个窗口，百分点）----
// 来源两处，取最近的一次：外援账本 helper-calls.jsonl（调 Claude/GPT/Go 顾问前后各记一笔）、
// 额度历史 quota-history.jsonl（每次刷新一笔；DSH 平时用 Go 的消耗在这里）。窗口已经重置过的不算。
const HC = { go: 'go', chatgpt: 'gpt', claude: 'claude' };
const K2 = { '5h': '5小时', '7d': '每周', '30d': '每月' };
let spendCache = { at: 0, v: {} };
// 重置时间统一成毫秒：账本里是秒，历史里是 ISO 字符串
const normR = (r) => (typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : Date.parse(r) || null);
function lastSpend() {
  if (Date.now() - spendCache.at < 10000) return spendCache.v;
  const out = {};
  const put = (prov, t, per) => { if (!out[prov] || t > out[prov].at) out[prov] = { at: t, per }; };
  for (const c of readJsonl(path.join(paths.aibox, 'helper-calls.jsonl')).slice(-200)) {
    const prov = Object.keys(HC).find((k) => HC[k] === c.helper);
    if (!prov || !c.before || !c.after) continue;
    const per = {};
    for (const [k, w] of Object.entries(K2)) { const a = c.before[k], b = c.after[k]; if (a && b && a.r === b.r && b.u >= a.u) per[w] = { d: b.u - a.u, r: b.r }; }
    if (Object.values(per).some((x) => x.d > 0)) put(prov, c.end || c.t, per);
  }
  const hist = readJsonl(path.join(paths.aibox, 'quota-history.jsonl')).slice(-400);
  for (const prov of ['go', 'chatgpt', 'claude']) {
    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1][prov], b = hist[i][prov]; if (!a || !b) continue;
      const per = {};
      for (const w of Object.values(K2)) if (a[w] && b[w] && a[w].r === b[w].r && b[w].u > a[w].u) per[w] = { d: b[w].u - a[w].u, r: b[w].r };
      if (Object.keys(per).length) { put(prov, hist[i].t, per); break; }
    }
  }
  spendCache = { at: Date.now(), v: out };
  return out;
}

function minLeft(o) { if (!o || !o.windows) return null; const v = Object.values(o.windows).map(winLeft).filter((x) => x != null); return v.length ? Math.min(...v) : null; }

export default {
  name: 'system', desc: '盒子本身：健康、资源、服务、网络、能耗、额度',
  setup(app) {
    refreshQuotaCache();
    app.every(60000, () => refreshQuotaCache());
    app.api('quota', () => { const q = quotaSnapshot(), held = reservations(q); return { snapshotId: q.id, updatedAt: q.updatedAt, providers: Object.values(q.providers).map(p => ({ id: p.id, label: p.label, state: p.state, observedAt: p.observedAt, fetchedAt: p.fetchedAt, left: p.left, windows: p.windows, dispatch: assess(p, {}, held) })) }; });
    refresh();   // 启动就预热，第一次打开面板也不用等
    app.badge('system', async () => problems(await status()).length || null);
    app.api('health', async () => { const d = await status(); return { problems: problems(d) }; });

    app.widget({ id: 'sys.health', page: 'home', order: 13, size: 's', kind: 'stat', title: '盒子', icon: '🖥', link: '#system',
      data: async () => { const p = problems(await status()); return p.length ? { value: p.length, unit: '项异常', tone: 'bad', sub: short(p.join('、'), 16) } : { value: '正常', tone: 'good' }; } });

    // ---- 资源四个环 ----
    const ring = (id, title, order, f) => app.widget({ id, page: 'system', order, size: 's', kind: 'ring', title, data: async () => f(await status()) });
    ring('sys.cpu', 'CPU', 1, (d) => ({ pct: (d.cpu_usage || 0) / 100, sub: d.cpu_temp != null ? d.cpu_temp + '°C' : '', tone: lvUsed(d.cpu_usage || 0) }));
    ring('sys.mem', '内存', 2, (d) => ({ pct: d.mem.pct / 100, sub: d.mem.used + '/' + d.mem.total, tone: lvUsed(d.mem.pct) }));
    ring('sys.disk', '存储', 3, (d) => { const p = parseFloat((d.disk.root || {}).pct) || 0; return { pct: p / 100, sub: (d.disk.root || {}).used + '/' + (d.disk.root || {}).size, tone: lvUsed(p) }; });
    ring('sys.batt', '电池', 4, (d) => (d.battery ? { pct: d.battery.pct / 100, sub: d.battery.conservation ? '插电·保护中' : d.battery.state, tone: d.battery.pct <= 15 ? 'bad' : 'good' } : { pct: 0, sub: '无电池', tone: 'mute' }));

    app.widget({ id: 'sys.links', page: 'system', order: 10, size: 'm', kind: 'list', title: '微信链路',
      data: async () => { const d = await status(); const w = d.wxlink || {}, U = w.units || {};
        return { items: [{ icon: '💬', title: '当前大脑', badge: { dsh: 'DSH', ai: 'OpenClaw', local: '本地模型' }[w.mode || 'ai'], tone: 'info' },
          ...Object.entries(WX).map(([u, n]) => ({ icon: U[u] === 'active' ? '🟢' : '🔴', title: n, badge: U[u] === 'active' ? '运行' : '停了', tone: U[u] === 'active' ? 'good' : u === 'aibox-ollama-tunnel' ? 'warn' : 'bad' }))] }; } });
    app.widget({ id: 'sys.services', page: 'system', order: 11, size: 'm', kind: 'chips', title: '服务',
      data: async () => { const d = await status(); const c = d.chatlink || {};
        return { items: [...(d.services || []).map((s) => ({ text: s.name, tone: s.active ? 'good' : 'bad' })), { text: 'AstrBot', tone: c.astrbot === 'active' ? 'good' : 'bad' }, { text: '企微', tone: c.wecom === 'connected' ? 'good' : 'bad' }] }; } });
    app.widget({ id: 'sys.net', page: 'system', order: 20, size: 'm', kind: 'kv', title: '网络', mobile: 'hide',
      data: async () => { const d = await status(); const wi = (d.net && d.net.wifi) || {};
        return { items: [{ k: 'WiFi', v: wi.ssid || '未连接' }, ...(wi.signal != null ? [{ k: '信号', v: wi.signal + ' dBm' }] : []), ...Object.entries((d.net && d.net.ip) || {}).slice(0, 2).map(([k, v]) => ({ k, v })), { k: 'Tailscale', v: d.tailscale }] }; } });
    app.widget({ id: 'sys.power', page: 'system', order: 21, size: 'm', kind: 'bars', title: '能耗', mobile: 'hide',
      data: async () => { const p = (await status()).power; if (!p || !p.days) return { items: [], empty: '没有数据' };
        return { unit: 'Wh', items: p.days.slice().reverse().map((x) => ({ x: x.date.slice(5).replace('-', '/'), a: Math.round((x.measured || 0) * 10) / 10, b: Math.round((x.estimated || 0) * 10) / 10, tip: x.wh.toFixed(1) + ' Wh' })), legend: ['实测', '估算'] }; } });
    app.widget({ id: 'sys.open', page: 'system', order: 30, size: 'm', kind: 'list', title: '打开',
      data: () => ({ items: [
        { icon: '🖥', title: '看屏幕', sub: 'noVNC', href: 'http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale' },
        { icon: '⚙️', title: 'Cockpit', sub: 'Tailscale', href: 'https://127.0.0.1:9090/' },
        { icon: '🧩', title: '网关结构', sub: '插件 · 卡片', href: '/api/v2/describe' },
      ] }) });

    // ---- AI 额度 ----
    const quota = () => readJson(paths.quota, null);
    app.widget({ id: 'quota', page: ['home', 'system'], order: 31, size: 'm', kind: 'meters', title: '额度', icon: '⛽',
      data() {
        const raw = quota(); if (!raw) return { items: [], empty: '计量器还没数据' };
        const q = quotaSnapshot(), held = reservations(q), spend = lastSpend();
        const WIN = [['5小时', '5h', 5 * 3600e3], ['每周', '周', 7 * 86400e3], ['每月', '月', 30 * 86400e3]];
        const names = { fresh: '', stale: '旧读数', unknown: '待确认', pending_reset: '重置待确认', unavailable: '不可用' };
        const items = Object.values(q.providers).map(p => {
          const sp = spend[{ gpt: 'chatgpt', wb: 'workbuddy' }[p.id] || p.id], decision = assess(p, {}, held);
          const windows = WIN.flatMap(([key,k,len]) => {
            const x = p.windows[key]; if (!x) return [];
            const left = p.raw.ok ? x.left : null, at = x.resetAt > Date.now() ? x.resetAt : null;
            const lr = sp?.per[key] ? normR(sp.per[key].r) : null;
            return [{ k, left, text: left == null ? '—' : Math.round(left) + '%', tone: left == null ? 'mute' : lvLeft(left), resetAt: at, resetLabel: p.id === 'wb' ? '刷新/到期' : '重置',
              status: x.pending ? '重置待确认' : p.state === 'stale' ? '旧读数' : '',
              pace: key !== '5小时' && at ? Math.max(0, Math.min(100, Math.round((at - Date.now()) / len * 100))) : null,
              last: lr && at && Math.abs(lr - at) < 120000 && left != null ? Math.min(sp.per[key].d, 100 - left) : null }];
          });
          const urgent = decision.urgent;
          const sub = [p.state === 'unavailable' ? names[p.state] : '', urgent ? '优先派工' : '', p.observedAt ? ago(p.observedAt) + '核实' : '无最新读数', p.id === 'wb' && !p.windows['每月']?.resetAt ? '月刷新·日期待确认' : ''].filter(Boolean).join(' · ');
          const v = p.state === 'pending_reset' || !p.raw.ok ? null : p.left;
          return { label: p.label === 'WorkBuddy' ? 'WB' : p.label, pct: v ?? 0, text: v == null ? '待确认' : Math.round(v) + '%',
            tone: p.state === 'unavailable' ? 'bad' : v == null ? 'mute' : lvLeft(v), sub,
            resetAt: urgent?.resetAt || null, windows: windows.length ? windows : null, snapshotId: q.id };
        });
        return { items, foot: '同一份额度用于派工 · 每家显示实际核实时间', snapshotId: q.id };
      },
      detail() {
        const q = quota(); if (!q) return { sections: [] };
        const snap = quotaSnapshot();
        const win = (id) => { const p = snap.providers[id]; return Object.entries(p.windows).map(([k,w]) => ({ label: k, pct: p.raw.ok ? w.left ?? 0 : 0,
          text: w.pending ? '重置待确认' : !p.raw.ok || w.left == null ? '待确认' : Math.round(w.left) + '%',
          tone: w.left == null || !p.raw.ok ? 'mute' : lvLeft(w.left), sub: (p.state === 'stale' ? '旧读数 · ' : '') + (p.observedAt ? ago(p.observedAt) + '核实' : '未取得读数'), resetAt: w.resetAt > Date.now() ? w.resetAt : null })); };
        return { sections: [
          { title: 'OpenCode Go（DSH 主力）', kind: 'meters', data: { items: win('go') } },
          { title: 'ChatGPT（外援）', kind: 'meters', data: { items: win('gpt') } },
          { title: 'Claude（外援，和你共用）', kind: 'meters', data: { items: win('claude') } },
          ...(q.workbuddy && q.workbuddy.ok ? [{ title: 'WorkBuddy（DSH 回落线，' + (q.workbuddy.plan || '?') + '）', kind: 'meters', data: { items: win('wb') } },
            { kind: 'kv', data: { items: [
              { k: '剩余', v: Number(q.workbuddy.quotaRemaining).toFixed(0) + ' / ' + q.workbuddy.quotaTotal },
              { k: '已用', v: Number(q.workbuddy.quotaUsed).toFixed(0) },
              ...(q.workbuddy.expirationAt ? [{ k: '登录有效至', v: new Date(q.workbuddy.expirationAt).toLocaleDateString('zh-CN') }] : []),
            ] } }] : []),
          ...(q.deepseek && q.deepseek.ok ? [{ title: 'DeepSeek（按量）', kind: 'kv', data: { items: [{ k: '余额', v: (q.deepseek.currency === 'CNY' ? '¥' : '$') + Number(q.deepseek.balance).toFixed(2) }] } }] : []),
          { kind: 'note', data: { text: 'Go 的强模型（kimi-k3、gpt-6-luna 等）按 4 倍扣额度。' } },
          ...(q.workbuddy?.buckets?.length ? [{ title: 'WB 月周期', kind: 'list', data: { items: q.workbuddy.buckets.map(b => ({ title: b.label, sub: new Date(b.resetsAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' 刷新/到期', badge: Math.round(b.remaining) + ' 积分' })) } }] : []),
          ...(q.workbuddy && q.workbuddy.ok ? [{ kind: 'note', data: { text: 'WorkBuddy 按月刷新。月刷新日期从套餐周期读取，登录有效期不作为额度重置日。日期未取得时正常派工，不按临近到期加速。' } }] : []),
        ] };
      },
    });
  },
};
