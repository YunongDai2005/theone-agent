/**
 * 外援提醒：helper 启动的外援（Claude / Codex / Go / WorkBuddy 顾问）脱离 DSH 运行，DSH 这一轮结束后才做完的结果没人看。
 * 下一轮开头由网关（代码，不靠模型记得）告诉它：做完没取走的（每个只提醒一次）、还在跑的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { quotaSnapshot, reservations } from '../core/quota-runtime.mjs';
import { assess } from '../core/quota-policy.mjs';
import { paths } from '../core/config.mjs';
import { log, emit, tag } from '../core/log.mjs';
import { ago, short } from '../observe/fmt.mjs';

const WHO = { gpt: 'Codex', claude: 'Claude Code', go: 'Go 顾问', wb: 'WorkBuddy 顾问' };

export function listJobs(limit = 30) {
  let ids = [];
  try { ids = fs.readdirSync(paths.helperJobs).sort().reverse().slice(0, limit); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const p = path.join(paths.helperJobs, id, 'meta.json');
    try { out.push({ id, p, m: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch {}
  }
  return out;
}

export function helperNote() {
  const done = [], running = [];
  for (const { id, p, m } of listJobs()) {
    const who = (WHO[m.helper] || m.helper) + (m.work ? '（干活）' : '（顾问）');
    if (m.status === 'running') running.push('- ' + id + ' ' + who + ' 还在跑：' + m.title + ' → helper status ' + id);
    else if (!m.delivered && !m.announced && Date.parse(m.endedAt || 0) > Date.now() - 3 * 86400e3) {
      done.push('- ' + id + ' ' + who + (m.status === 'done' ? ' ✓ 做完了' : ' ✕ ' + m.status) + '：' + m.title + ' → helper result ' + id);
      try { fs.writeFileSync(p, JSON.stringify({ ...m, announced: true }, null, 2)); } catch {}
    }
  }
  if (!done.length && !running.length) return '';
  return '【外援任务 — 系统自动附上】\n' + (done.length ? '上一轮之后做完、结果还没看的（先看结果再回答主人）：\n' + done.join('\n') + '\n' : '') +
    (running.length ? '还在后台跑的：\n' + running.join('\n') + '\n' : '') + '（别在回复里复述这段）\n\n';
}

// 经理用：一句话说清外援在跑什么
export function helperBrief() {
  const run = listJobs(200).map((x) => x.m).filter((m) => m.status === 'running');
  return run.length ? '工人请的外援在跑：' + run.map((m) => (WHO[m.helper] || m.helper) + '「' + m.title + '」').join('、') : '';
}

export default {
  name: 'helpers', desc: '外援（Claude/Codex/Go/WorkBuddy）做完的结果，下一轮自动提醒工人去看',
  setup(app) {
    app.stage('context', 40, (T) => {
      const hn = helperNote();
      if (hn) { T.text = hn + T.text; log('helper note attached chat=' + T.chat + ' chars=' + hn.length); emit('helpers.noted', { chat: tag(T.chat) }); }
    });
    app.stage('context', 45, (T) => {
      const q = quotaSnapshot(), held = reservations(q);
      const urgent = Object.values(q.providers).flatMap(p => { const u = assess(p, {}, held).urgent; return u ? [p.label + ' ' + u.minutes + '分钟后刷新/到期，尚余' + Math.round(u.left) + '%可优先使用'] : []; });
      if (urgent.length) T.text = '【额度派工提示】' + urgent.join('；') + '。对当前已授权任务，可提前安排适合的审查、测试或独立子任务；用 helper start auto，遵守额度预留，不为了烧额度编造任务。\n\n' + T.text;
    });
    app.api('helpers', () => listJobs(20).map(({ id, m }) => ({ id, helper: m.helper, work: !!m.work, status: m.status, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt })));

    app.widget({ id: 'worker.helpers', page: 'worker', order: 20, size: 'm', kind: 'list', title: '外援', icon: '🤝',
      data: () => ({ items: listJobs(6).map(({ m }) => ({ icon: { claude: '🟠', gpt: '🟢', go: '🔵', wb: '🟣' }[m.helper] || '⚪', title: short(m.title, 22), sub: (WHO[m.helper] || m.helper) + (m.work ? ' · 干活' : '') + ' · ' + ago(m.endedAt || m.startedAt),
        badge: { running: '在跑', done: '完成', failed: '失败', killed: '停了' }[m.status] || m.status, tone: { running: 'info', done: 'good', failed: 'bad' }[m.status] || 'mute' })), empty: '最近没请外援' }) });
  },
};
