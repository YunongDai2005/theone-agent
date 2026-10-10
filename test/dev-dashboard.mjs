#!/usr/bin/env node
/**
 * 面板预览：起一个假环境里的真网关（带样例数据 + 一个正在跑的任务），在 http://127.0.0.1:<端口>/ 看面板。
 *   node test/dev-dashboard.mjs [端口，默认 8933] [--widget 你的卡片.json]
 * 做新卡片时用它看效果，不碰真实数据。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, APP_DIR } from './harness.mjs';

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a))) || 8933;
const extra = args.includes('--widget') ? args[args.indexOf('--widget') + 1] : null;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const ymd = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// 假的机器状态（系统卡片读它）
const sysStatus = {
  host: 'ai-box', cpu_usage: 12.4, cpu_temp: 46, mem: { used: '6.1G', total: '11.1G', pct: 55 }, disk: { root: { used: '8.0G', size: '96G', pct: '9%' }, pools: [{ name: 'rpool', health: 'ONLINE' }] },
  battery: { pct: 60, conservation: true }, wxlink: { mode: 'dsh', units: { 'wx-router': 'active', 'openclaw-gateway': 'active', 'aibox-ollama-tunnel': 'inactive', 'aibox-quota.timer': 'active' } },
  chatlink: { astrbot: 'active', wecom: 'connected' }, services: ['ssh', 'aibox-vnc', 'ufw', 'cockpit', 'tailscaled'].map((name) => ({ name, active: true })),
  net: { wifi: { ssid: 'Home-5G', signal: -42 }, ip: { wlp2s0: '127.0.0.1/24' } }, tailscale: '已登录',
  power: { days: Array.from({ length: 7 }, (_, i) => ({ date: ymd(Date.now() - i * 86400e3), wh: 30 + i * 3, measured: 28 + i * 3, estimated: i === 6 ? 5 : 0 })) },
};
const sysSrv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(sysStatus)); });
await new Promise((r) => sysSrv.listen(0, '127.0.0.1', r));

const env = await startEnv({
  config: { systemStatusUrl: 'http://127.0.0.1:' + sysSrv.address().port + '/', progressFirstMs: 600000, dshTimeoutMs: 3600000, dshWarnMs: 3000000 },
  async setup(env) {
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    for (let i = 6; i >= 1; i--) {
      const d = ymd(Date.now() - i * 86400e3), ok = rnd(8, 22), bad = rnd(0, 3);
      env.writeJson('.aibox/evolve/metrics/' + d + '.json', { day: d, counters: { 'msg.in': ok + bad + 9, 'turn.done': ok, 'turn.empty': bad, 'topic.misroute': rnd(0, 1), 'signal.complaint': rnd(0, 2) }, dist: { 'turn.ms': Array.from({ length: ok }, () => rnd(8000, 240000)) } });
    }
    env.writeJson('.aibox/quota.json', { updatedAt: new Date().toISOString(), go: { ok: true, windows: { '5小时': { usedPercent: 12, resetsAt: iso(2.3 * 3600e3) }, '每周': { usedPercent: 31, resetsAt: iso(3.4 * 86400e3) }, '每月': { usedPercent: 18, resetsAt: iso(20 * 86400e3) } }, pace: { used: 18 } }, chatgpt: { ok: true, windows: { '5小时': { usedPercent: 38, resetsAt: iso(3.2 * 3600e3) }, '每周': { usedPercent: 40, resetsAt: iso(5.2 * 86400e3) } }, advisor: { calls: 0 } }, claude: { ok: true, windows: { '5小时': { usedPercent: 71, resetsAt: iso(2.1 * 3600e3) }, '每周': { usedPercent: 26, resetsAt: iso(4 * 86400e3) } }, advisor: { calls: 22 } }, deepseek: { ok: true, balance: 26.4, currency: 'CNY' }, workbuddy: { ok: true, plan: '月套餐', windows: { '每月': { usedPercent: 35, resetsAt: iso(18 * 86400e3) } } } });
    // 上一次调用花了多少（虚线段）：Go 看额度历史，Claude 看外援账本
    const q = env.readJson('.aibox/quota.json');
    const h = (u5) => ({ t: Date.now(), go: { '5小时': { u: u5, r: q.go.windows['5小时'].resetsAt }, '每周': { u: 28, r: q.go.windows['每周'].resetsAt } } });
    fs.writeFileSync(env.file('.aibox/quota-history.jsonl'), [h(4), h(12)].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const cr = Math.round(Date.parse(q.claude.windows['5小时'].resetsAt) / 1000), cw = Math.round(Date.parse(q.claude.windows['每周'].resetsAt) / 1000);
    fs.writeFileSync(env.file('.aibox/helper-calls.jsonl'), JSON.stringify({ t: Date.now() - 9 * 60e3, end: Date.now() - 8 * 60e3, helper: 'claude', before: { '5h': { u: 58, r: cr }, '7d': { u: 23, r: cw } }, after: { '5h': { u: 71, r: cr }, '7d': { u: 26, r: cw } } }) + '\n');
    env.writeJson('.aibox/evolve/last-retro.json', { day: ymd(Date.now() - 86400e3), at: Date.now() - 5 * 3600e3, stats: { turns: 17, ok: 15, successRate: 0.88, p50: 38000, p90: 212000 }, counts: { complaint: 2, retry: 1, misroute: 2 }, changes: [] });
    fs.mkdirSync(env.file('.aibox/evolve/proposals'), { recursive: true });
    env.writeJson('.aibox/evolve/proposals/0001.json', { id: '0001', status: 'proposed', createdAt: Date.now() - 5 * 3600e3, title: '追问句别当成新话题', problem: '昨天 2 次「切错了」都在「那这个呢」这类追问之后。', change: 'threads.mjs 的 isTrivial 补追问句式。', kind: 'prompt', risk: '低', history: [] });
    env.writeJson('wx-router/tunables.json', { values: { threadTh: { switchSure: 0.77 } }, history: [{ at: Date.now() - 5 * 3600e3, key: 'threadTh.switchSure', from: 0.75, to: 0.77, reason: '昨天切错 2 次', level: 'L1' }] });
    fs.mkdirSync(env.file('dsh-work/handoffs'), { recursive: true });
    fs.writeFileSync(env.file('dsh-work/handoffs/INDEX.md'), '| # | 时间 | 标题 | 关键词 | 文件 |\n|---|---|---|---|---|\n| 0001 | 09-27 10:00 | 官网改版：首页结构定稿 | x | a |\n| 0002 | 09-28 11:00 | 论文笔记：第三章整理完 | x | b |\n| 0003 | 09-28 21:30 | 杭州周末行程 | x | c |\n');
    const d = env.file('.aibox/helper-jobs/c-0929-101500-ab'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ helper: 'claude', status: 'done', title: '审一下官网改版的代码', startedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), endedAt: new Date(Date.now() - 2.8 * 3600e3).toISOString(), announced: true }));
    // 一张"不写代码"的卡片示例：知识库条目数
    fs.mkdirSync(env.file('dsh-work/knowledge'), { recursive: true });
    for (let i = 0; i < 45; i++) fs.writeFileSync(env.file('dsh-work/knowledge/k' + i + '.md'), 'x');
    env.writeJson('.aibox/widgets/kb.json', { id: 'kb.count', page: 'memory', order: 3, size: 's', kind: 'stat', title: '知识库', source: { type: 'count', dir: env.file('dsh-work/knowledge'), match: '\\.md$' }, map: { value: '$', unit: '条' } });
    if (extra) fs.copyFileSync(extra, env.file('.aibox/widgets/' + path.basename(extra)));
  },
});
await env.say('/dsh'); await env.waitText('已切换');
for (const t of ['把这周的周报整理成三条要点', '查一下周六上午去杭州的高铁']) { await env.say(t); await env.waitText('ECHO:' + t); await env.idle(); }
// 前 40 个字之后才放指令，面板标题只显示前面的正常文字
await env.say('帮我把官网首页的文案改得更有说服力，再写三个版本的标题给我挑一挑，改完发预览链接给我 #sleep=600000 #milestone=首页文案初稿写完');   // 一直在跑，看"干活中"的样子

const html = () => fs.readFileSync(path.join(APP_DIR, 'web/index.html'));
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/v2/')) {
    try { const r = await fetch('http://127.0.0.1:' + env.apiPort + req.url); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
    catch { res.writeHead(502); res.end('{}'); }
    return;
  }
  // 预览专用：/?open=Go,Claude 预先把这几家额度设成展开（截图用）
  const open = new URL(req.url, 'http://x').searchParams.get('open');
  if (open != null) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html().toString().replace('<script>', '<script>localStorage.setItem("aibox-qopen",' + JSON.stringify(JSON.stringify(open.split(',').filter(Boolean))) + ');</script><script>')); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html());
}).listen(PORT, '127.0.0.1', () => console.log('面板预览：http://127.0.0.1:' + PORT + '/'));
process.on('SIGINT', async () => { await env.stop(); env.cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await env.stop(); env.cleanup(); process.exit(0); });
