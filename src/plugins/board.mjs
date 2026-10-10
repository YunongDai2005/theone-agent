/**
 * 工作台卡片：工人状态、今天的数字、7 天趋势、事件流、「需要你处理」。
 * 其它卡片由各功能插件自己带（话题、交接、经理、外援、进化、系统…），见 docs/WIDGETS.md。
 */
import { cfg } from '../core/config.mjs';
import { recentEvents } from '../core/log.mjs';
import * as live from '../observe/live.mjs';
import * as metrics from '../observe/metrics.mjs';
import { short, span, spanText, ago, pct, hm } from '../observe/fmt.mjs';

const LV_ICON = { say: '💬', tool: '🔧', milestone: '📍', note: 'ℹ️', err: '⚠️', done: '✅' };
const ST = { done: ['完成', 'good'], failed: ['失败', 'bad'], interrupted: ['打断', 'warn'] };

// 事件 → 一行人话（面板事件流、详情都用）
const EV = {
  'turn.done': (e) => ['✅', '回复了 · ' + spanText(e.ms)],
  'turn.empty': (e) => ['⚠️', e.killedBy === 'idle' ? '卡死，已停下' : e.killedBy === 'max' ? '超时，已停下' : '没返回内容'],
  'turn.interrupted': () => ['⏸', '被打断'],
  'turn.error': () => ['⚠️', '出错'],
  'topic.route': (e) => (e.action === 'new' ? ['🧵', '开新话题'] : e.action === 'switch' ? ['🧵', '切回旧话题'] : null),
  'topic.misroute': () => ['↩️', '切错了，撤回'],
  'manager.decide': (e) => ['🧑‍💼', { none: '经理回答', note: '经理记下', redo: '经理让它改', stop: '经理叫停', queue: '经理排队', answer: '经理转达回答', split: '经理拆话题', fallback: '经理没联系上' }[e.action] || '经理'],
  'mailbox.deliver': (e) => ['📬', '补交 ' + e.n + ' 条留言'],
  'stop.done': (e) => (e.ok ? ['⛔', '叫停'] : null),
  'steer': (e) => ['🔁', e.same ? '插话，接着改' : '插话，换话题'],
  'session.rotate': (e) => ['🆕', '换会话 · ' + ({ daily: '新的一天', idle: '隔太久', context: '上下文满' }[e.reason] || e.reason)],
  'handoff.built': () => ['🗂', '写好交接包'],
  'route.fallback': (e) => ['↪️', e.quota ? 'Go 额度满 → DeepSeek' : 'Go 失败 → DeepSeek'],
  'recall.attached': () => ['📚', '附上交接目录'],
  'evolve.retro': (e) => ['🧬', '复盘 · 调参 ' + e.changes + ' · 提案 ' + e.proposals],
  'evolve.proposal': (e) => ['🧬', '新提案 #' + Number(e.id)],
  'signal': (e) => (['complaint', 'retry', 'noisy', 'resume_after_kill'].includes(e.kind) ? ['👀', { complaint: '你好像不满意', retry: '你重发了一遍', noisy: '你嫌播报吵', resume_after_kill: '停下后你让它继续' }[e.kind]] : null),
  'gateway.start': () => ['🚀', '网关启动'],
  'mode.switch': (e) => ['🔀', '切到 ' + ({ dsh: 'DSH', ai: 'OpenClaw', local: '本地模型' }[e.mode] || e.mode)],
};
export function humanEvents(limit = 40) {
  const out = [];
  for (const e of recentEvents(0, 500).reverse()) {
    const f = EV[e.type]; const r = f && f(e);
    if (r) out.push({ t: hm(e.ts), icon: r[0], text: r[1] });
    if (out.length >= limit) break;
  }
  return out;
}

function currentRun() { const s = live.snapshot(); return { run: s.running[0] || null, last: s.recent[0] || null, n: s.running.length, recent: s.recent }; }

export default {
  name: 'board', desc: '面板：工人、今天、趋势、事件、需要你处理',
  setup(app) {
    app.badge('worker', () => (live.snapshot().running.length ? '●' : null));
    // ---- 工人（首页 + 工人页）----
    app.widget({
      id: 'worker', page: ['home', 'worker'], order: 1, size: 'xl', kind: 'hero', title: '工人', link: '#worker',
      data() {
        const { run, last, n } = currentRun();
        if (!run) return { state: 'idle', title: '空闲', sub: last ? '上一个：' + short(last.task, 20) + ' · ' + (ST[last.status] || [last.status])[0] + ' · ' + ago(last.endedAt) : '在微信里给它派活' };
        const cur = run.current || {};
        return {
          state: run.kind === 'handoff' ? 'handoff' : 'busy', title: short(run.task, 40), startedAt: run.startedAt, limitMs: run.limitMs,
          now: { icon: cur.kind === 'tool' ? '🔧' : '💭', text: short(cur.label, 36), since: cur.since },
          stats: [{ k: '步', v: run.step }, { k: '工具', v: run.tools }].concat(n > 1 ? [{ k: '并行', v: n }] : []),
          milestone: run.milestones && run.milestones.length ? short(run.milestones.at(-1).x, 40) : '',
          quietMs: Date.now() - (run.lastAt || run.startedAt), idleMs: run.idleMs,
        };
      },
      detail() {
        const { run, last } = currentRun();
        const r = run || last;
        if (!r) return { sections: [] };
        return { sections: [
          { title: short(r.task, 60), kind: 'kv', data: { items: [{ k: '用时', v: spanText((r.endedAt || Date.now()) - r.startedAt) }, { k: '步数', v: r.step }, { k: '工具', v: r.tools }, { k: '线路', v: r.route === 'deepseek' ? 'DeepSeek' : 'Go' }] } },
          { title: '过程', kind: 'feed', data: { items: (r.events || []).slice().reverse().map((e) => ({ t: '+' + spanText(e.t - r.startedAt), icon: e.tool && /^codex/.test(e.tool) ? '🤝' : LV_ICON[e.k] || '·', text: short(e.x, 80), tone: e.st === 'err' ? 'bad' : '' })) } },
        ] };
      },
    });
    // ---- 这一轮的过程（工人页）----
    app.widget({
      id: 'worker.steps', page: 'worker', order: 15, size: 'm', kind: 'feed', title: '过程', mobile: 'show',
      data() {
        const { run, last } = currentRun();
        const r = run || last;
        if (!r) return { items: [], empty: '还没有任务' };
        return { items: (r.events || []).slice(-30).reverse().map((e) => ({ t: '+' + spanText(e.t - r.startedAt), icon: e.tool && /^codex/.test(e.tool) ? '🤝' : LV_ICON[e.k] || '·', text: short(e.x, 60), tone: e.st === 'err' ? 'bad' : '' })) };
      },
    });
    app.widget({
      id: 'worker.recent', page: 'worker', order: 30, size: 'm', kind: 'list', title: '最近任务',
      data() {
        const { recent } = currentRun();
        return { items: recent.slice(0, 6).map((r) => ({ title: short(r.task, 26), sub: ago(r.endedAt) + ' · ' + spanText(r.took), badge: (ST[r.status] || [r.status])[0], tone: (ST[r.status] || [0, 'mute'])[1] })), empty: '还没有' };
      },
    });

    // ---- 今天的数字（首页）----
    const today = () => metrics.today() || {};
    const yday = () => metrics.day(metrics.dayKey(Date.now() - 86400e3)) || {};
    app.widget({ id: 'today.turns', page: ['home', 'worker'], order: 10, size: 's', kind: 'stat', title: '今日任务', icon: '📋',
      data: () => { const t = today(); return { value: t.turns || 0, unit: '个', sub: t.failed ? t.failed + ' 个失败' : '' , tone: t.failed ? 'warn' : '' }; } });
    app.widget({ id: 'today.rate', page: 'home', order: 11, size: 's', kind: 'stat', title: '成功率', icon: '🎯',
      data: () => { const t = today(), y = yday(); if (t.successRate == null) return { value: '–', sub: '今天还没任务' };
        const d = y.successRate == null ? null : t.successRate - y.successRate;
        return { value: Math.round(t.successRate * 100), unit: '%', delta: d == null || Math.abs(d) < 0.005 ? null : { dir: d > 0 ? 'up' : 'down', good: d > 0 }, tone: t.successRate < 0.7 ? 'bad' : t.successRate < 0.9 ? 'warn' : 'good' }; } });
    app.widget({ id: 'today.time', page: 'worker', order: 4, size: 's', kind: 'stat', title: '一般要', icon: '⏱',
      data: () => { const t = today(); const s = span(t.p50); return { value: s.v, unit: s.u, sub: t.p90 != null ? '慢的 ' + spanText(t.p90) : '' }; } });
    app.widget({ id: 'today.signals', page: 'evolve', order: 3, size: 's', kind: 'stat', title: '不满意', icon: '👀', link: '#evolve',
      data: () => { const t = today(); const n = (t.complaints || 0) + (t.misroutes || 0) + (t.retries || 0); return { value: n, unit: '次', tone: n >= 3 ? 'warn' : n ? '' : 'good', sub: n ? '' : '都挺顺' }; } });

    // ---- 7 天趋势 ----
    app.widget({ id: 'trend', page: 'home', order: 30, size: 'm', kind: 'bars', title: '7 天', mobile: 'show',
      data: () => { const got = new Map(metrics.lastDays(7).map((d) => [d.day, d])); if (!got.size) return { items: [], empty: '用几天就有了' };
        // 永远画满 7 天：没数据的日子留空位，不然只有一天时一根柱子会铺满整张图
        const days = Array.from({ length: 7 }, (_, i) => { const k = metrics.dayKey(Date.now() - (6 - i) * 86400e3); return got.get(k) || { day: k, turns: 0, ok: 0, failed: 0, successRate: null }; });
        return { items: days.map((d) => ({ x: d.day.slice(5).replace('-', '/'), a: d.ok || 0, b: d.failed || 0, line: d.successRate, tip: d.turns + ' 个任务 · 成功率 ' + pct(d.successRate) })), legend: ['成功', '失败', '成功率'] }; } });

    // ---- 事件流（工人页）----
    app.widget({ id: 'events', page: 'worker', order: 40, size: 'm', kind: 'feed', title: '动态', mobile: 'hide', data: () => ({ items: humanEvents(30), empty: '还没有动态' }) });

    // ---- 需要你处理（首页；没事就不显示）----
    app.widget({
      id: 'inbox', page: 'home', order: 2, size: 'xl', kind: 'list', title: '需要你', icon: '🔔',
      async data() {
        const items = [];
        const get = async (n) => { const f = app.apis.get(n); try { return f ? await f(new URLSearchParams()) : null; } catch { return null; } };
        const m = await get('manager');
        if (m && m.question) items.push({ icon: '❓', title: '工人在等你回答', sub: short(m.question.q, 40), tone: 'warn' });
        const e = await get('evolve');
        for (const p of (e && e.proposals) || []) {
          if (p.status === 'proposed') items.push({ icon: '🧬', title: '#' + Number(p.id) + ' ' + short(p.title, 18), sub: '发 /批准 ' + Number(p.id) + ' 或 /否决 ' + Number(p.id), badge: '待批准', tone: 'violet' });
          if (p.status === 'ready') items.push({ icon: '🚀', title: '#' + Number(p.id) + ' ' + short(p.title, 18), sub: '测试过了 · 发 /上线 ' + Number(p.id), badge: '可上线', tone: 'good' });
        }
        return items.length ? { items } : null;
      },
    });
  },
};
