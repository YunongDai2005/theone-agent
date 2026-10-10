/** Native DSH questions/approvals return to their exact chat, run and event. */
import * as mgr from '../manager/core.mjs';
import { cfg } from '../core/config.mjs';
import { serviceClient } from '../agent/service-client.mjs';
import { emit, tag, mask, log } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as live from '../observe/live.mjs';

export function answerValue(q, text) {
  const options = q.options || [];
  const t = text.trim();
  const index = /^\d+$/.test(t) ? Number(t) - 1 : -1;
  const chosen = options[index] || options.find(x => x.label === t);
  return { id: q.id, selected: chosen ? [chosen.label] : [], ...(chosen ? {} : { custom: t }) };
}
export default {
  name: 'interaction', desc: '工人原生提问、审批经微信往返，按任务编号确认',
  setup(app) {
    const contexts = new Map(), pending = new Map();
    app.listen('chat-context', ({ chat, msg }) => contexts.set(chat, msg));
    const active = (p) => {
      const a = app.agent.active(p.chat);
      return a?.runId === p.runId && a.state === 'running' && a.pendingRequest?.eventId === p.eventId;
    };
    const visible = () => [...pending.values()].filter(active);
    function message(p) {
      const code = p.eventId.slice(0, 8);
      if (p.event === 'approval/request') return '需要你确认 [' + code + ']\n' + mask(p.request?.toolName || '工具操作') + '\n' + mask(p.request?.reason || '').slice(0, 500) + '\n回复 /通过 ' + code + ' 或 /拒绝 ' + code;
      const q = p.request.questions[p.index];
      return '想确认一下 [' + code + ']\n' + mask(q.question || q.title || q.prompt || '') + '\n' + (q.options || []).map((x, i) => (i + 1) + '. ' + mask(x.label) + (x.description ? '：' + mask(x.description) : '')).join('\n') + '\n直接回复答案，或 /回答 ' + code + ' 答案。';
    }
    app.listen('worker-request', (q) => {
      if (q.event === 'user-questions/request' && (!Array.isArray(q.request?.questions) || !q.request.questions.length)) return;
      const existing = pending.get(q.chat);
      if (existing?.eventId === q.eventId) return;
      const p = { ...q, index: 0, answers: [], responding: false }; pending.set(q.chat, p);
      emit('worker.question', { chat: tag(q.chat), kind: q.event === 'approval/request' ? 'approval' : 'question' });
      void wx.reply(contexts.get(q.chat) || q.msg, message(p)).catch(e => log('worker question send failed: ' + e.message));
    });
    async function respond(ctx, explicit, code, text) {
      const p = pending.get(ctx.chat);
      if (!p || !active(p)) {
        pending.delete(ctx.chat);
        if (explicit) await wx.replySoft(ctx.msg, '这个问题已经结束，回答没有送给其他任务。');
        return explicit ? 'consume' : undefined;
      }
      if (code && code !== p.eventId.slice(0, 8)) { await wx.replySoft(ctx.msg, '编号不匹配，请使用当前问题的编号。'); return 'consume'; }
      if (p.responding) { await wx.replySoft(ctx.msg, '正在提交上一条回答，稍等。'); return 'consume'; }
      let value;
      if (p.event === 'approval/request') {
        if (!explicit || !code || !['通过', '拒绝'].includes(text)) {
          if (/^(通过|允许|好|同意|拒绝|不同意)$/.test(text)) { await wx.replySoft(ctx.msg, '请回复 /通过 ' + p.eventId.slice(0, 8) + ' 或 /拒绝 ' + p.eventId.slice(0, 8) + '，确认对应操作。'); return 'consume'; }
          return undefined; // supplementary requirements still go to the Manager
        }
        value = text === '通过' ? 'allowed-once' : 'rejected';
      } else {
        const answer = answerValue(p.request.questions[p.index], text);
        if (p.index < p.request.questions.length - 1) {
          p.answers.push(answer); p.index++;
          await wx.replySoft(ctx.msg, message(p)); return 'consume';
        }
        value = { answers: [...p.answers, answer] };
      }
      p.responding = true;
      try {
        await serviceClient().rpc('$events/result', { clientId: p.clientId, eventId: p.eventId, outcome: { kind: 'result', value } });
        if (pending.get(ctx.chat) === p) pending.delete(ctx.chat);
        app.agent.active(ctx.chat)?.clearRequest?.();
        emit('worker.answered', { chat: tag(ctx.chat), kind: p.event === 'approval/request' ? 'approval' : 'question' });
        await wx.replySoft(ctx.msg, p.event === 'approval/request' ? (value === 'allowed-once' ? '已确认本次操作。' : '已拒绝本次操作。') : '回答已送达，它会接着做。');
      } catch {
        p.responding = false;
        await wx.replySoft(ctx.msg, '回答提交失败，还没确认送达。请重试当前问题。');
      }
      return 'consume';
    }
    app.command({ names: ['/回答', '/通过', '/拒绝'], pattern: /^\/(回答|通过|拒绝)\s+(\S+)(?:\s+([\s\S]+))?$/,
      help: '回答工人问题，或按编号确认／拒绝本次操作',
      handle: (ctx, m) => respond(ctx, true, m[2], m[1] === '回答' ? (m[3] || '') : m[1]) });
    app.workerQuestion = chat => { const p = pending.get(chat); return p && active(p) ? { id: p.eventId, q: p.request?.questions?.[p.index]?.question || '待确认工具操作', at: new Date(p.at).toISOString(), chat, native: true, kind: p.event === 'approval/request' ? 'approval' : 'question' } : null; };
    app.answerWorkerQuestion = (ctx, text) => respond(ctx, true, null, text);
    app.ingress(55, 'native-answer', (ctx) => {
      if (ctx.mode !== 'dsh' || !ctx.said || ctx.said.startsWith('/')) return;
      const p = pending.get(ctx.chat);
      if (p?.event === 'user-questions/request' && active(p)) {
        const q = p.request.questions[p.index], t = ctx.said.trim();
        const option = (q.options || []).some(x => x.label === t) || /^\d+$/.test(t);
        if (!option && mgr.isOn(ctx.chat, cfg.managerMode)) return; // Manager separates answers from new requirements.
      }
      return respond(ctx, false, null, ctx.said);
    });
    app.every(5000, () => { for (const [chat, p] of pending) if (!active(p)) pending.delete(chat); });
    const report = () => visible().map(p => ({ id: p.eventId.slice(0, 8), kind: p.event === 'approval/request' ? 'approval' : 'question',
      title: mask(p.event === 'approval/request' ? p.request?.toolName : p.request?.questions?.[p.index]?.question || ''), at: p.at, chat: tag(p.chat) }));
    app.api('interaction', () => ({ pending: report() }));
    app.widget({ id: 'worker.questions', page: ['home', 'worker'], order: 2, size: 'm', kind: 'list', title: '等你',
      data: () => { const rows = report(); return rows.length ? { items: rows.map(p => ({ title: p.title, sub: '#' + p.id + ' · 微信回复', tone: 'warn' })) } : null; } });
    app.listen('input-receipt', ({ ids, chat }) => {
      const run = live.runningFor(chat)[0]; run?.note('收到 ' + ids.length + ' 条中途补充');
      const msg = contexts.get(chat);
      if (msg) void wx.replySoft(msg, '补充已接入当前任务。');
    });
  },
};
