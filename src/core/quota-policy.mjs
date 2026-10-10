/** Shared interpretation for dashboard, manager and advisor dispatch. No I/O or clock side effects. */
export const POLICY = { normalMs: 300000, urgentMs: 60000, horizonMs: 3600000,
  reservePct: 10, shortReservePct: 2, sharedReservePct: 5, concurrency: 2 };
export const PROVIDERS = { go: 'Go', gpt: 'GPT', claude: 'Claude', wb: 'WorkBuddy' };
export const stamp = (x) => { if (x == null || x === '') return null; const n = typeof x === 'number' ? (x < 1e12 ? x * 1000 : x) : Date.parse(x); return Number.isFinite(n) ? n : null; };
const number = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x) => Math.max(0, Math.min(100, x));
const short = (k) => /5小时|5h|rolling|小时/.test(k);
export function windowView(w, now = Date.now()) {
  if (!w) return null;
  const resetAt = stamp(w.resetsAt);
  const pending = w.reset === true || (resetAt != null && resetAt <= now);
  return { resetAt, pending, left: !pending && number(w.usedPercent) ? clamp(100 - w.usedPercent) : null,
    expiringLeft: number(w.expiringPercent) ? clamp(w.expiringPercent) : null,
    reportedLeft: number(w.usedPercent) ? clamp(100 - w.usedPercent) : null,
    blocked: !pending && (number(w.usedPercent) && w.usedPercent >= 100 || ['limited', 'exceeded', 'blocked'].includes(w.status)) };
}
export function snapshot(raw = {}, now = Date.now()) {
  const out = { id: raw.snapshotId || raw.updatedAt || 'unknown', updatedAt: stamp(raw.updatedAt), providers: {} };
  for (const [id, label] of Object.entries(PROVIDERS)) {
    const o = raw[{ gpt: 'chatgpt', wb: 'workbuddy' }[id] || id] || {};
    // Re-reading a local ledger is not a new upstream measurement. Explicit null stays unknown.
    const observedAt = stamp('observedAt' in o ? o.observedAt : 'asOf' in o ? o.asOf : o.ok ? raw.updatedAt : null);
    const windows = Object.fromEntries(Object.entries(o.windows || {}).filter(([, w]) => w).map(([k, w]) => [k, windowView(w, now)]));
    const resets = Object.values(windows).map(w => w.resetAt).filter(t => t > now);
    const near = resets.some(t => t - now <= POLICY.horizonMs);
    const ttlMs = near ? POLICY.urgentMs : POLICY.normalMs;
    const pending = Object.values(windows).some(w => w.pending);
    const cooldown = id === 'go' && stamp(raw.goCooldownUntil) > now;
    const knownBlocked = Object.values(windows).some(w => w.blocked) || cooldown ||
      ((o.available === false || o.limitReached || o.limited) && !(stamp(o.resetsAt) && stamp(o.resetsAt) <= now));
    const ageMs = observedAt == null ? null : Math.max(0, now - observedAt);
    const fresh = o.ok === true && observedAt != null && observedAt <= now + 60000 && ageMs <= ttlMs && !pending;
    const state = o.configured === false || knownBlocked ? 'unavailable' : pending ? 'pending_reset' :
      !o.ok || observedAt == null ? 'unknown' : fresh ? 'fresh' : 'stale';
    const vals = Object.values(windows).map(w => w.left).filter(number);
    const left = o.ok && vals.length ? Math.min(...vals) : null;
    out.providers[id] = { id, label, state, fresh, observedAt, fetchedAt: stamp(o.fetchedAt), ageMs, ttlMs, windows,
      left, near, raw: o, text: label + '：' + describe({ state, windows }) };
  }
  return out;
}
const STATE = { fresh: '已确认', stale: '旧读数', unknown: '待确认', pending_reset: '重置待确认', unavailable: '不可用' };
export function describe(p) {
  const ws = Object.entries(p.windows).map(([k, w]) => k + (w.pending ? '重置待确认' : w.left == null ? '待确认' : '剩' + Math.round(w.left) + '%')).join(' ');
  return STATE[p.state] + (ws ? '；' + ws : '');
}
export function expectedCost(p, opts = {}) {
  const factor = opts.work || opts.hard ? 1.5 : opts.quick ? 0.5 : 1;
  const per = p.raw.advisor?.perCall || {};
  return Object.fromEntries(Object.keys(p.windows).map(k => {
    const key = short(k) ? '5h' : /周|7d/.test(k) ? '7d' : '30d';
    // Estimates, not exact token billing. Floors also cover zero-rounded samples.
    return [k, Math.max(short(k) ? 3 : 1, number(per[key]) ? per[key] : 0) * factor];
  }));
}
export function assess(p, opts = {}, reservations = [], now = Date.now()) {
  const cost = expectedCost(p, opts), active = reservations.filter(r => r.helper === p.id);
  const max = p.fresh ? POLICY.concurrency : 1;
  const reasons = [];
  if (p.state === 'unavailable') reasons.push('额度或线路不可用');
  if (active.length >= max) reasons.push('已有任务占用');
  const remaining = {};
  for (const [k, w] of Object.entries(p.windows)) {
    const held = active.reduce((s, r) => s + (r.resets?.[k] === w.resetAt ? r.cost?.[k] || 0 : 0), 0);
    remaining[k] = w.left == null ? null : Math.max(0, w.left - held);
    const reserve = short(k) && p.fresh && w.resetAt - now <= POLICY.horizonMs ? (p.id === 'claude' ? POLICY.sharedReservePct : POLICY.shortReservePct) : POLICY.reservePct;
    if (remaining[k] != null && remaining[k] - (cost[k] || 0) < reserve) reasons.push(k + '不足（含在途预留）');
  }
  let urgent = null;
  // Only current, verified readings can drive deadline acceleration. Every longer cap has already passed above.
  if (p.fresh && !reasons.length) for (const [k, w] of Object.entries(p.windows)) {
    const ms = w.resetAt - now;
    const expectedMs = (opts.expectedSeconds || (opts.quick ? 60 : opts.work ? 1200 : 600)) * 1000;
    const expiring = w.expiringLeft == null ? remaining[k] : Math.min(remaining[k], w.expiringLeft);
    if (w.resetAt == null || ms <= 0 || ms > POLICY.horizonMs || ms < expectedMs || expiring < Math.max(5, (cost[k] || 1)*3)) continue;
    const score = Math.round(expiring / (ms / 3600000 + 0.25));
    if (!urgent || score > urgent.score) urgent = { window: k, resetAt: w.resetAt, minutes: Math.ceil(ms / 60000), left: expiring, score };
  }
  // Optional per-model limits are enforced when the provider reports them. Missing limits are not invented.
  const modelLimit = p.raw.modelLimits?.[opts.model];
  const modelWindows = modelLimit?.windows || (modelLimit ? { model: modelLimit } : {});
  if (Object.values(modelWindows).some(w => windowView(w, now)?.blocked)) reasons.push('模型单独额度已满');
  if (reasons.length) urgent = null;
  return { allowed: !reasons.length, reasons, remaining, cost, maxConcurrency: max, urgent, confidence: p.state };
}
// Manager states which alternatives fit the task. Never substitute a lower capability tier for quota urgency.
export function prioritize(candidates, chosen, suitable = [chosen]) {
  const base = candidates[chosen]; if (!base) return null;
  const pool = suitable.filter(i => candidates[i]).map(i => ({ ...candidates[i], index: i })).filter(c => c.helper && c.tier === base.tier && c.quota?.allowed);
  const urgent = pool.filter(c => c.quota.urgent).sort((a, b) => b.quota.urgent.score - a.quota.urgent.score);
  return urgent[0] || { ...base, index: chosen };
}
export function workerRoute(q, held = [], now = Date.now()) {
  const go = assess(q.providers.go, { model:'deepseek-v4.1-flash', quick:true }, held, now);
  const wb = assess(q.providers.wb, { model:'deepseek-v4.1-flash', quick:true }, held, now);
  if (!go.allowed) return wb.allowed ? 'workbuddy' : 'deepseek';
  if (wb.allowed && wb.urgent && (!go.urgent || wb.urgent.score > go.urgent.score)) return 'workbuddy';
  return 'go';
}
