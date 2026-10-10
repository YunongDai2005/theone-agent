/**
 * 自进化插件：收信号 → 每晚复盘（L0 报告 + L1 调参 + L2 提案）→ 主人在微信里批准/上线。
 *   /进化          昨天的复盘摘要 + 待处理的提案
 *   /批准 N        让外援在 WorkTree 里实现提案 N（跑测试，不上线）
 *   /上线 N        测试通过的提案合并并安全重启
 *   /否决 N        丢掉提案 N
 *   /复盘          现在就复盘一次昨天（不花钱写提案）
 *   /回滚调参       L1 自动调过的参数全部退回你 config.json 里的原值
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as metrics from '../observe/metrics.mjs';
import * as signals from '../evolve/signals.mjs';
import * as tunables from '../evolve/tunables.mjs';
import * as proposals from '../evolve/proposals.mjs';
import { runRetro, lastRetro } from '../evolve/retro.mjs';
import { ago, short, pct, spanText } from '../observe/fmt.mjs';

const STATUS = { proposed: '待批准', building: '外援实现中', ready: '测试通过·待上线', shipped: '已上线', rejected: '已否决', failed: '没做成', test_failed: '测试没过', merge_failed: '合并失败' };

function brief() {
  const r = lastRetro();
  const L = [];
  if (r) {
    const s = r.stats || {};
    L.push('🧬 最近复盘（' + r.day + '）：任务 ' + (s.turns || 0) + ' 个，成功率 ' + (s.successRate == null ? '—' : Math.round(s.successRate * 100) + '%') + '，p90 ' + (s.p90 == null ? '—' : Math.round(s.p90 / 1000) + ' 秒'));
    const c = r.counts || {};
    L.push('不满意信号：抱怨 ' + (c.complaint || 0) + ' · 切错了 ' + (c.misroute || 0) + ' · 叫停 ' + (c.stop || 0) + ' · 被停下 ' + (c.kill || 0));
    if (r.rolled) L.push('↩️ 回滚了 ' + r.rolled.key + '（' + r.rolled.why + '）');
    for (const ch of r.changes || []) L.push('🔧 ' + ch.key + ' ' + ch.from + ' → ' + ch.to + '（' + ch.reason + '）');
  } else L.push('🧬 还没复盘过（每天 ' + cfg.evolve.retroHour + ' 点自动复盘前一天）。');
  const open = proposals.list().filter((p) => ['proposed', 'building', 'ready', 'test_failed'].includes(p.status));
  if (open.length) {
    L.push('', '提案：');
    for (const p of open) L.push('#' + Number(p.id) + ' ' + p.title + ' · ' + (STATUS[p.status] || p.status) + '（' + p.kind + '，风险 ' + p.risk + '）\n   ' + p.problem.slice(0, 80));
    L.push('', '/批准 N 让外援去做 · /上线 N 合并重启 · /否决 N 丢掉');
  } else L.push('没有待处理的提案。');
  return L.join('\n');
}

export default {
  name: 'evolve', desc: '每晚复盘，自动微调参数，写改进提案（你批准才改代码）',
  setup(app) {
    signals.start();
    // 主人的每句话都过一遍信号检测（只看不拦）
    app.ingress(33, 'signals', (ctx) => { if (ctx.mode === 'dsh') signals.onUserText(tag(ctx.chat), ctx.said); });

    const notify = (t) => wx.notifyOwner(t).catch((e) => log('evolve notify ERROR ' + errText(e)));

    // 「/看板 描述」：让工人按 docs/WIDGETS.md 给面板造一张卡片（在哪个模式都行）
    app.command({
      pattern: /^\/看板\s+([\s\S]{2,300})$/, names: ['/看板 描述'], help: '让工人给面板加一张卡片，如：/看板 显示知识库有多少条',
      handle: (ctx, m) => {
        emit('widget.request', { chat: tag(ctx.chat) });
        wx.replySoft(ctx.msg, '🧩 好，交给工人做卡片，做好会告诉你放在哪一页。');
        app.agent.enqueue(ctx.msg, '【给面板做一张卡片 — 主人的要求】' + m[1] + '\n做法严格按 /home/aibox/wx-router/docs/WIDGETS.md：优先 JSON 卡片（widget lint → widget add → widget board 看效果）；标题 ≤4 个字，一个重点，解释放 detailText。做完用一句话告诉主人放在哪一页、叫什么。');
      },
    });
    app.command({ names: ['/看板'], help: '面板地址和每页有几张卡片', handle: async (ctx) => {
      const W = await import('../observe/widgets.mjs');
      const all = W.specs().widgets; const ps = W.pages();
      wx.replySoft(ctx.msg, '🧩 面板：' + cfg.dashboardUrl + '\n' + ps.map((p) => p.title + ' ' + all.filter((w) => w.pages.includes(p.id)).length + ' 张').join(' · ') + '\n加卡片：/看板 想看什么');
    } });
    app.command({ names: ['/进化', '进化'], help: '自进化：昨天的复盘、自动调参、改进提案', handle: (ctx) => wx.replySoft(ctx.msg, brief()) });
    app.command({
      names: ['/复盘'], help: '现在就复盘昨天（不写提案）',
      handle: async (ctx) => {
        try { const r = await runRetro(app, { llm: false }); wx.replySoft(ctx.msg, r.md.slice(0, 1700)); }
        catch (e) { wx.replySoft(ctx.msg, '⚠️ 复盘出错：' + errText(e)); }
      },
    });
    app.command({
      names: ['/回滚调参'], help: '自动调过的参数全部退回原值',
      handle: (ctx) => {
        const n = tunables.resetAll();
        wx.replySoft(ctx.msg, n ? '↩️ 已把自动调过的参数全部退回你的原始配置（下次重启完全生效）。' : '现在没有自动调过的参数。');
      },
    });
    app.command({
      pattern: /^\/?(批准|否决|上线)\s*#?(\d+)$/, help: '处理自进化提案（N 是编号）', names: ['/批准 N', '/否决 N', '/上线 N'],
      handle: (ctx, m) => {
        const [, verb, id] = m;
        let r;
        if (verb === '批准') r = proposals.approve(id);
        else if (verb === '否决') r = proposals.reject(id);
        else r = proposals.ship(id, { idle: () => !app.agent.anyBusy() });
        log('evolve ' + verb + ' #' + id + ' ok=' + r.ok);
        wx.replySoft(ctx.msg, (r.ok ? '' : '⚠️ ') + (verb === '批准' && r.ok ? '🧬 好，外援开工了（在独立副本里做，不影响现在的服务）：\n' : '') + r.msg);
      },
    });

    // 定时：每 10 分钟看一次 —— 到点就复盘昨天；推进在做的提案
    let retroRunning = false;
    app.every(10 * 60000, async () => {
      proposals.poll(notify);
      const now = new Date();
      const yesterday = metrics.dayKey(Date.now() - 86400e3);
      const last = lastRetro();
      if (retroRunning || now.getHours() < cfg.evolve.retroHour || (last && last.day >= yesterday)) return;
      retroRunning = true;
      try {
        const r = await runRetro(app, {});
        if (r.changes.length || r.rolled || r.props.length) notify(brief());
      } catch (e) { log('evolve retro ERROR ' + errText(e)); }
      finally { retroRunning = false; }
    });

    app.api('evolve', () => ({
      last: lastRetro(), tunables: tunables.describe(), history: tunables.state().history.slice(-30),
      proposals: proposals.list().slice(-30).map((p) => ({ id: p.id, title: p.title, status: p.status, statusText: STATUS[p.status] || p.status, kind: p.kind, risk: p.risk, problem: p.problem, change: p.change, createdAt: p.createdAt, diffstat: p.diffstat || '' })),
      signals: signals.readDay(metrics.dayKey()).slice(-30).map((s) => ({ ts: s.ts, kind: s.kind })),
    }));
    app.status(() => { const n = proposals.list().filter((p) => p.status === 'proposed' || p.status === 'ready').length; return n ? '进化：' + n + ' 个提案等你处理（/进化）' : ''; });

    app.badge('evolve', () => proposals.list().filter((p) => p.status === 'proposed' || p.status === 'ready').length || null);
    // ---- 卡片 ----
    const TONE = { proposed: 'violet', building: 'info', ready: 'good', shipped: 'good', rejected: 'mute', failed: 'bad', test_failed: 'bad', merge_failed: 'bad' };
    app.widget({ id: 'evolve.levels', page: 'evolve', order: 1, size: 'xl', kind: 'chips', title: '怎么进化',
      data: () => ({ items: [{ text: 'L0 观察 · 自动', tone: 'info' }, { text: 'L1 调参 · 自动', tone: 'good' }, { text: 'L2 改代码 · 你批准', tone: 'violet' }, { text: 'L3 安全/权限/花钱 · 永不', tone: 'bad' }] }),
      detailText: '每晚 3 点复盘前一天。L1 只在护栏内微调参数，变差自动回滚。L2 写提案，你 /批准 才让外援在副本里做并跑测试，你 /上线 才合并重启。新功能上线时它也会给自己加一张看板卡片。' });
    app.widget({ id: 'evolve.proposals', page: 'evolve', order: 2, size: 'l', kind: 'list', title: '提案', icon: '🧬',
      data: () => ({ items: proposals.list().slice(-8).reverse().map((p) => ({ icon: '#' + Number(p.id), title: short(p.title, 22), sub: p.status === 'proposed' ? '/批准 ' + Number(p.id) : p.status === 'ready' ? '/上线 ' + Number(p.id) : ago(p.createdAt), badge: STATUS[p.status] || p.status, tone: TONE[p.status] || 'mute' })), empty: '没有提案，挺好' }),
      detail: () => ({ sections: proposals.list().slice(-6).reverse().map((p) => ({ title: '#' + Number(p.id) + ' ' + p.title + ' · ' + (STATUS[p.status] || p.status), kind: 'kv', data: { items: [{ k: '问题', v: p.problem }, { k: '改法', v: p.change }, { k: '类型', v: ({ code: '改代码', prompt: '改话术', config: '改配置' }[p.kind] || p.kind) + ' · 风险' + p.risk }] } })) }) });
    app.widget({ id: 'evolve.retro', page: 'evolve', order: 4, size: 'm', kind: 'kv', title: '昨晚复盘', icon: '📝',
      data: () => { const r = lastRetro(); if (!r) return { items: [], empty: '今晚 3 点第一次复盘' }; const s = r.stats || {}, c = r.counts || {};
        return { items: [{ k: '日期', v: r.day }, { k: '任务', v: (s.turns || 0) + ' 个' }, { k: '成功率', v: pct(s.successRate) }, { k: '一般要', v: s.p50 == null ? '–' : spanText(s.p50) }, { k: '不满意', v: ((c.complaint || 0) + (c.retry || 0) + (c.misroute || 0)) + ' 次' }] }; } });
    app.widget({ id: 'evolve.tuning', page: 'evolve', order: 5, size: 'm', kind: 'rails', title: '自动调参', icon: '🎚',
      data: () => ({ items: tunables.describe().map((t) => { const ms = /Ms$/.test(t.key); const f = (v) => (ms ? Math.round(v / 6000) / 10 + '分' : v);
        return { label: ({ 'threadTh.switchSure': '话题切换', 'threadTh.newSure': '开新话题', progressEveryMs: '播报间隔', dshIdleMs: '卡死判定' })[t.key] || t.key, min: t.min, max: t.max, base: t.base, value: t.value, text: f(t.value), moved: t.value !== t.base }; }) }),
      detailText: '竖线是你的原始设置，圆点是现在的值。发 /回滚调参 全部退回。' });
    app.widget({ id: 'evolve.history', page: 'evolve', order: 6, size: 'm', kind: 'feed', title: '调整记录', mobile: 'hide',
      data: () => ({ items: tunables.state().history.slice(-12).reverse().map((h) => ({ t: ago(h.at), icon: h.level === 'L1' ? '🔧' : '↩️', text: h.key === '*' ? '全部回滚' : short(h.key.split('.').pop() + ' ' + h.from + '→' + h.to, 30) })), empty: '还没自动调过' }) });
  },
};
