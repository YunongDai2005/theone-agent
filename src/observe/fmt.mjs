// 面板卡片共用的"人话"格式：字越少越好
export const short = (s, n = 24) => { s = String(s ?? '').replace(/\[用户发来[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// 时长 → { v, u }（大数字 + 单位）
export function span(ms) {
  if (ms == null || !isFinite(ms)) return { v: '–', u: '' };
  if (ms < 1000) return { v: '<1', u: '秒' };
  if (ms < 60000) return { v: String(Math.round(ms / 1000)), u: '秒' };
  if (ms < 3600e3) return { v: (ms / 60000).toFixed(1).replace(/\.0$/, ''), u: '分' };
  return { v: (ms / 3600e3).toFixed(1).replace(/\.0$/, ''), u: '时' };
}
export const spanText = (ms) => { const s = span(ms); return s.v + s.u; };
export function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? m + '分前' : m < 1440 ? Math.round(m / 60) + '时前' : Math.round(m / 1440) + '天前';
}
export const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
export const hm = (t) => new Date(t).toTimeString().slice(0, 5);
