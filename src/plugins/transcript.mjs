/**
 * 微信转录：把入站消息原文按时间落到文件，供「转录一下 N 点前的微信」用。
 *
 * 为什么需要它：网关按设计只处理「归它管」的消息，其余原样还给 OpenClaw，
 * 事件日志（events.jsonl）又特意不放原文（只打码）。所以想事后转录，
 * 必须在入站管道里自己留一份原文。
 *
 * 写在哪：$AIBOX_HOME/transcripts/YYYY-MM-DD.jsonl（一天一个文件，追加写）
 *   每行一条 JSON：{ ts, time, chat, from, text, voice, media, mode }
 *
 * 红线（照 AGENTS.md）：
 *   - 只在本地落盘，不外发；
 *   - 只记文本/转写文字，媒体只记「有图/有文件」不下载；
 *   - 密码类敏感词不打码就记会出事 → 命中 SENSITIVE 的行整条跳过不记。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg, paths } from '../core/config.mjs';
import { log } from '../core/log.mjs';

// 命中就整条不落盘（宁可漏记，不可泄密）
const SENSITIVE = /(密码|口令|验证码|银行卡|身份证|支付密码|私钥|助记词|api[_-]?key|token)/i;

// 与其它运行状态文件（modes.json 等）放同一层，跟 AIBOX_ROOT 走
const dir = () => path.join(paths.root, 'transcripts');

function fileFor(d = new Date()) {
  const p = dir();
  fs.mkdirSync(p, { recursive: true });
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(p, day + '.jsonl');
}

function mediaOf(msg) {
  const items = (msg && msg.item_list) || [];
  const has = (m) => m && (m.encrypt_query_param || m.full_url);
  if (items.some((i) => i.type === 2 && has(i.image_item && i.image_item.media))) return 'image';
  if (items.some((i) => i.type === 5 && has(i.video_item && i.video_item.media))) return 'video';
  if (items.some((i) => i.type === 4 && has(i.file_item && i.file_item.media))) return 'file';
  if (items.some((i) => i.type === 3 && has(i.voice_item && i.voice_item.media))) return 'voice';
  return '';
}

/** 记一条。失败绝不抛（不能因为转录把正常对话搞挂）。 */
export function record(ctx) {
  try {
    const { msg, chat, t, said } = ctx;
    const text = String(t || said || '').trim();
    const media = mediaOf(msg);
    if (!text && !media) return;          // 纯媒体之外的空消息不记
    if (SENSITIVE.test(text)) return;     // 敏感词整条跳过
    const now = new Date();
    const rec = {
      ts: now.getTime(),
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
      chat: String(chat || ''),
      from: String((msg && msg.from_user_id) || ''),
      text,
      voice: !t && !!said,                // 语音转写来的文字
      media,
      mode: ctx.mode || 'ai',
    };
    fs.appendFileSync(fileFor(now), JSON.stringify(rec) + '\n');
  } catch (e) {
    log('transcript ERROR ' + String((e && e.message) || e));
  }
}

export default {
  name: 'transcript', desc: '入站微信原文按天落盘，供事后转录',
  setup(app) {
    // order 35：排在 33 信号、34 计数 之后，不挡住后面任何环节
    app.ingress(35, 'transcript', (ctx) => { record(ctx); return undefined; });

    // 面板/脚本取用：GET /api/v2/transcript?date=YYYY-MM-DD[&before=HH:MM]
    app.api('transcript', (q) => {
      const day = q.get('date') || new Date().toISOString().slice(0, 10);
      const before = q.get('before') || '';
      const f = path.join(dir(), day + '.jsonl');
      let rows = [];
      try {
        rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* 当天还没消息 */ }
      if (before) rows = rows.filter((r) => r.time <= before);
      return { date: day, before, count: rows.length, items: rows };
    });

    // 面板卡片：今天记了多少条、最后一条是什么时候
    app.widget({
      id: 'transcript.today', page: 'memory', order: 60, size: 's', kind: 'stat', title: '转录',
      data: () => {
        const f = path.join(dir(), new Date().toISOString().slice(0, 10) + '.jsonl');
        let rows = [];
        try { rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return null; }
        const last = rows.length ? (() => { try { return JSON.parse(rows[rows.length - 1]); } catch { return null; } })() : null;
        return { value: rows.length + ' 条', sub: last ? '最后 ' + last.time : '今天还没有', tone: 'good' };
      },
      detailText: '把所有进来的微信原文按天记在 transcripts/ 下（敏感词整条不记）。主人说「转录一下」时从这里取。',
    });
  },
};
