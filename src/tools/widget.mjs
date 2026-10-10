#!/usr/bin/env node
/**
 * widget：给面板加卡片的命令行工具（DSH / 外援 / 主人都能用）。说明见 docs/WIDGETS.md。
 *
 *   widget list                 现在有哪些卡片（插件自带的 + JSON 的），以及哪些 JSON 卡片有错
 *   widget lint 卡片.json        检查格式 + 真的取一次数据给你看（不会放上面板）
 *   widget add  卡片.json        检查通过后放进 ~/.aibox/widgets/，面板几秒内自动出现（不用重启）
 *   widget rm   <id>             下架一张 JSON 卡片（文件改名成 .json.off，随时能恢复）
 *   widget board [页面]          看某一页现在显示什么（home/worker/memory/evolve/system/自定义页）
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../core/config.mjs';
import { validate, previewData, widgetDir, KINDS } from '../observe/widgets.mjs';

const [cmd, arg] = process.argv.slice(2);
const api = async (name) => { const r = await fetch('http://127.0.0.1:' + (cfg.apiPort || 8788) + '/api/v2/' + name, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error('网关 API ' + name + ' 返回 ' + r.status); return r.json(); };
const die = (m) => { console.error('✕ ' + m); process.exit(1); };

async function lint(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('读不了或不是 JSON：' + e.message); }
  const errs = validate(s);
  if (errs.length) die('格式不对：\n  - ' + errs.join('\n  - ') + '\n（kind 可选：' + KINDS.join(' / ') + '）');
  let data;
  try { data = await previewData(s, api); } catch (e) { die('格式对，但取数据失败：' + e.message); }
  console.log('✓ 格式正确，数据：\n' + JSON.stringify(data, null, 2).slice(0, 1500));
  return s;
}

if (cmd === 'lint') { if (!arg) die('用法：widget lint 卡片.json'); await lint(arg); }
else if (cmd === 'add') {
  if (!arg) die('用法：widget add 卡片.json');
  const s = await lint(arg);
  fs.mkdirSync(widgetDir(), { recursive: true });
  const to = path.join(widgetDir(), s.id + '.json');
  fs.copyFileSync(arg, to);
  console.log('✓ 已放上面板：' + to + '\n  页面「' + [].concat(s.page).join('、') + '」几秒内出现，不用重启。看效果：widget board ' + [].concat(s.page)[0]);
}
else if (cmd === 'rm') {
  if (!arg) die('用法：widget rm <id>');
  const f = path.join(widgetDir(), arg + '.json');
  if (!fs.existsSync(f)) die('没有这张 JSON 卡片（插件自带的卡片要改插件代码）：' + f);
  fs.renameSync(f, f + '.off');
  console.log('✓ 已下架（文件改名为 ' + path.basename(f) + '.off，改回来就恢复）');
}
else if (cmd === 'list') {
  const w = await api('widgets');
  for (const x of w.widgets) console.log((x.origin === 'file' ? '📄 ' : '🧩 ') + x.id.padEnd(22) + ' ' + x.kind.padEnd(7) + ' ' + x.pages.join('/').padEnd(14) + ' ' + (x.plugin || x.file));
  if (w.errors.length) { console.log('\n有错的 JSON 卡片：'); for (const e of w.errors) console.log('  ✕ ' + e.file + '：' + e.errors.join('；')); }
}
else if (cmd === 'board') {
  const b = await api('board?page=' + (arg || 'home'));
  console.log('页面：' + b.pages.map((p) => p.id + (p.badge ? '(' + p.badge + ')' : '')).join(' '));
  for (const w of b.widgets) console.log((w.error ? '✕ ' : '· ') + w.id.padEnd(22) + ' ' + w.size + ' ' + w.kind.padEnd(7) + ' ' + (w.error || JSON.stringify(w.data).slice(0, 90)));
}
else { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^ \* ?/, '')).join('\n')); }
