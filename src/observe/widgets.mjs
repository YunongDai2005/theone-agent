/**
 * 看板卡片（widget）注册中心 —— 面板是"积木"，每个功能自己带卡片。
 *
 * 两种来源：
 *   1) 插件代码：app.widget({ id, page, kind, size, title, icon, data, detail })
 *   2) 不写代码：~/.aibox/widgets/*.json（DSH 或自进化上线新功能时放一个文件就有卡片，热加载，不用重启）
 *
 * 卡片类型（kind）和数据形状见 docs/WIDGETS.md；前端 index.html 只是一个通用渲染器。
 * 面板 API：
 *   GET /api/v2/board?page=home   这一页所有卡片 + 数据（一次拿全）
 *   GET /api/v2/detail?id=xxx     点开卡片看的详情
 *   GET /api/v2/widgets           所有卡片的定义 + JSON 卡片的校验错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/config.mjs';
import { log, errText, recentEvents } from '../core/log.mjs';
import * as metrics from './metrics.mjs';

export const KINDS = ['hero', 'stat', 'ring', 'meters', 'bars', 'list', 'feed', 'chips', 'kv', 'rails', 'note'];
export const SIZES = ['s', 'm', 'l', 'xl'];
export const TONES = ['good', 'warn', 'bad', 'info', 'violet', 'mute'];
// 内置页面；JSON 卡片可以用 pageTitle/pageIcon 开新页面
export const BASE_PAGES = [
  { id: 'home', title: '首页', icon: 'home' },
  { id: 'worker', title: '工人', icon: 'worker' },
  { id: 'memory', title: '记忆', icon: 'memory' },
  { id: 'evolve', title: '进化', icon: 'evolve' },
  { id: 'system', title: '系统', icon: 'system' },
];

const code = new Map();         // id -> spec（插件注册的）
const badges = new Map();       // page -> fn() → 数字 / '●' / null（导航上的小角标）
export function badge(page, fn) { badges.set(page, fn); }
let fileCache = { at: 0, sig: '', specs: [], errors: [] };
export const widgetDir = () => path.join(paths.aibox, 'widgets');

export function register(spec, plugin) {
  const errs = validate(spec, true);
  if (errs.length) throw new Error('卡片 ' + spec.id + ' 定义有误：' + errs.join('；'));
  code.set(spec.id, { ...spec, pages: [].concat(spec.page), plugin, origin: 'plugin' });
}

export function validate(s, isCode = false) {
  const e = [];
  if (!s || typeof s !== 'object') return ['不是对象'];
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(s.id || '')) e.push('id 只能用小写字母/数字/点/横线（2~41 位）');
  if (!KINDS.includes(s.kind)) e.push('kind 必须是 ' + KINDS.join('/'));
  if (s.size && !SIZES.includes(s.size)) e.push('size 必须是 s/m/l/xl');
  if (!s.page || ![].concat(s.page).every((p) => /^[a-z0-9-]{2,20}$/.test(p))) e.push('page 必填（home/worker/memory/evolve/system 或新页面 id）');
  if (!s.title || String(s.title).length > 8) e.push('title 必填，最多 8 个字（字越少越好）');
  if (s.mobile && !['show', 'hide'].includes(s.mobile)) e.push('mobile 只能是 show/hide');
  if (isCode) { if (typeof s.data !== 'function') e.push('data 必须是函数'); }
  else {
    const src = s.source || {};
    if (!['static', 'file', 'count', 'metric', 'events', 'api'].includes(src.type)) e.push('source.type 必须是 static/file/count/metric/events/api');
    if ((src.type === 'file' || src.type === 'count') && !insideHome(src.path || src.dir)) e.push('source 的路径必须在 ' + paths.home + ' 下');
  }
  return e;
}
const insideHome = (p) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(paths.home) + path.sep);

// ---------- JSON 卡片：按目录 mtime 热加载 ----------
function loadFiles() {
  const dir = widgetDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return fileCache = { at: Date.now(), sig: '', specs: [], errors: [] }; }
  const sig = names.map((f) => { try { return f + ':' + fs.statSync(path.join(dir, f)).mtimeMs; } catch { return f; } }).join('|');
  if (sig === fileCache.sig) return fileCache;
  const specs = [], errors = [];
  for (const f of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { errors.push({ file: f, errors: ['JSON 解析失败：' + errText(e)] }); continue; }
    if (s.enabled === false) continue;
    const errs = validate(s);
    if (code.has(s.id)) errs.push('id 和插件卡片重名');
    if (errs.length) { errors.push({ file: f, id: s.id, errors: errs }); continue; }
    specs.push({ ...s, pages: [].concat(s.page), origin: 'file', file: f });
  }
  if (errors.length) log('widgets: ' + errors.length + ' 个 JSON 卡片有误 ' + errors.map((x) => x.file).join(','));
  return fileCache = { at: Date.now(), sig, specs, errors };
}

// ---------- JSON 卡片的数据来源 ----------
function pick(obj, p) {
  if (!p || p === '$') return obj;
  return String(p).replace(/^\$\.?/, '').split('.').filter(Boolean).reduce((x, k) => (x == null ? x : x[k]), obj);
}
// map：{ value: "$", unit: "条", sub: "$.note" } —— "$..." 取数据，其它原样
function applyMap(map, v) {
  if (!map) return v;
  const out = {};
  for (const [k, t] of Object.entries(map)) out[k] = typeof t === 'string' && t.startsWith('$') ? pick(v, t) : t;
  return out;
}
async function sourceValue(src, app) {
  switch (src.type) {
    case 'static': return src.data;
    case 'file': {
      const p = path.resolve(src.path);
      const st = fs.statSync(p);
      if (st.size > 1024 * 1024) throw new Error('文件超过 1MB');
      const txt = fs.readFileSync(p, 'utf8');
      const v = src.jsonl ? JSON.parse(txt.trim().split('\n').pop()) : JSON.parse(txt);
      return pick(v, src.pick);
    }
    case 'count': {
      const re = src.match ? new RegExp(src.match) : null;
      const walk = (d, depth) => {
        let n = 0;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) { if (src.recursive && depth < 4) n += walk(path.join(d, e.name), depth + 1); }
          else if (!re || re.test(e.name)) n++;
        }
        return n;
      };
      return walk(path.resolve(src.dir), 0);
    }
    case 'metric': {
      if (src.days) return metrics.lastDays(Math.min(30, src.days)).map((d) => ({ x: d.day.slice(5), v: (metrics.raw(d.day)?.counters || {})[src.name] || 0 }));
      return (metrics.raw(metrics.dayKey())?.counters || {})[src.name] || 0;
    }
    case 'events': {
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      return recentEvents(t0.getTime(), 500).filter((e) => e.type === src.name).length;
    }
    case 'api': { const fn = app.apis.get(src.name); if (!fn) throw new Error('没有这个 API：' + src.name); return pick(await fn(new URLSearchParams()), src.pick); }
  }
  throw new Error('未知来源');
}

// 给命令行工具用：不启动网关也能算出一张 JSON 卡片的数据（api 来源通过 getApi 取）
export async function previewData(spec, getApi) {
  const app = { apis: new Map() };
  if (spec.source && spec.source.type === 'api') app.apis.set(spec.source.name, () => getApi(spec.source.name));
  return applyMap(spec.map, await sourceValue(spec.source, app));
}

function all() { return [...code.values(), ...loadFiles().specs]; }
export function specs() {
  return { widgets: all().map(({ data, detail, ...s }) => ({ ...s, hasDetail: !!detail || !!s.detailText })), errors: loadFiles().errors };
}
export function pages() {
  const out = [...BASE_PAGES];
  for (const s of all()) for (const p of s.pages) if (!out.some((x) => x.id === p)) out.push({ id: p, title: s.pageTitle || p, icon: s.pageIcon || 'grid', custom: true });
  return out;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))]);
async function dataOf(s, app) {
  if (s.origin === 'plugin') return s.data();
  return applyMap(s.map, await sourceValue(s.source, app));
}

export async function board(app, page = 'home') {
  const list = all().filter((s) => s.pages.includes(page)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const widgets = await Promise.all(list.map(async (s) => {
    const base = { id: s.id, kind: s.kind, size: s.size || 'm', title: s.title, icon: s.icon || '', mobile: s.mobile || 'show', link: s.link || '', hasDetail: !!s.detail || !!s.detailText, origin: s.origin };
    try {
      const data = await withTimeout(Promise.resolve(dataOf(s, app)), 3000);
      if (data == null) return null;           // 数据函数返回 null = 这张卡现在不用显示（例如「需要你处理」为空）
      return { ...base, data };
    } catch (e) { return { ...base, error: errText(e).slice(0, 80) }; }
  }));
  const bs = {};
  for (const [p, fn] of badges) { try { const v = await withTimeout(Promise.resolve(fn()), 2000); if (v) bs[p] = v; } catch {} }
  return { page, pages: pages().map((p) => ({ ...p, badge: bs[p.id] || null })), widgets: widgets.filter(Boolean), at: Date.now() };
}

export async function detail(app, id) {
  const s = all().find((x) => x.id === id);
  if (!s) throw new Error('没有这张卡片');
  if (s.detail) return s.detail();
  if (s.detailText) return { sections: [{ kind: 'note', data: { text: s.detailText } }] };
  return { sections: [] };
}

// 给结构描述 / 自进化用：哪些插件还没有卡片
export function coverage(app) {
  const has = new Set([...code.values()].map((s) => s.plugin));
  return app.plugins.filter((p) => !p.core && !has.has(p.name)).map((p) => p.name);
}
