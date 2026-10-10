#!/usr/bin/env node
/** Reading pending requirements does not acknowledge applying them. */
import { mailboxAll, receipt } from '../manager/core.mjs';
const args = process.argv.slice(2), val = k => args[args.indexOf(k) + 1];
const chat = process.env.AIBOX_CHAT, runId = process.env.AIBOX_RUN_ID;
const session = args.includes('--session') ? val('--session') : '';
const items = mailboxAll().filter(x => session ? x.receipt?.sessionId === session : chat && x.chat === chat && (!x.runId || x.runId === runId));
if (!chat && !session) { console.error('缺少任务范围，请带 --session 会话编号；没有确认任何留言。'); process.exit(1); }
if (args.includes('--ack')) {
  const ids = val('--ack').split(',');
  if (ids.some(id => !items.find(x => x.id === id && ['delivered','applied'].includes(x.delivery)))) {
    console.error('只能确认已交给当前会话的留言。'); process.exit(1);
  }
  receipt(ids, 'applied', { via: 'worker-ack' }); console.log('已确认处理：' + ids.join(','));
} else {
  const rows = args.includes('--all') ? items.slice(-20) : items.filter(x => x.delivery !== 'applied');
  for (const x of rows) console.log('[' + x.id + ' / ' + x.delivery + '] 主人补充：' + x.text);
  if (!rows.length) console.log('（没有新留言）');
  else console.log('处理并验证后执行 mailbox --ack <编号>' + (session ? ' --session ' + session : '') + '，再报告实际改变。');
}
