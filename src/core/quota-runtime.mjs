/** Shared cache refresh and cross-process locks. Also imported by /home/aibox/bin/helper.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg, paths } from './config.mjs';
import { snapshot, stamp, expectedCost } from './quota-policy.mjs';
const read = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function quotaSnapshot() { return snapshot(read(paths.quota)); }
export async function withLock(name, fn, waitMs = 35000) {
  fs.mkdirSync(paths.aibox, { recursive: true });
  const lock = path.join(paths.aibox, name + '.lock'), start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() })); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = read(path.join(lock, 'owner.json'));
      const age = Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if ((owner.pid && !alive(owner.pid)) || !owner.pid && age > 5000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - start >= waitMs) throw new Error('等待额度锁超时：' + name);
      await sleep(100);
    }
  }
  const cleanup = () => { if (read(path.join(lock, 'owner.json')).pid === process.pid) fs.rmSync(lock, { recursive: true, force: true }); };
  process.once('exit', cleanup); // helper CLI exits after dispatch; exit must also release its reservation lock.
  try { return await fn(); } finally { process.removeListener('exit', cleanup); cleanup(); }
}
let inflight = null;
export function refreshQuota({ force = false } = {}) {
  if (inflight) return inflight;
  const raw = read(paths.quota), q = snapshot(raw), now = Date.now();
  const fetched = stamp(raw.updatedAt);
  const due = !fetched || now - fetched > (Object.values(q.providers).some(p => p.id !== 'claude' && (p.near || p.state === 'pending_reset')) ? 60000 : 300000) ||
    Object.values(q.providers).some(p => p.state === 'fresh' && p.near && now - (p.fetchedAt || 0) > 60000);
  if (!force && !due) return Promise.resolve(q);
  const script = path.join(paths.bin, 'aibox-quota.mjs');
  if (!fs.existsSync(script)) return Promise.resolve(q);
  inflight = new Promise(resolve => {
    const child = spawn(process.execPath, [script, '--no-notify'], { stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 30000);
    const done = () => { clearTimeout(timer); resolve(quotaSnapshot()); };
    child.once('error', done); child.once('close', done);
  }).finally(() => { inflight = null; });
  return inflight;
}
export async function dispatchSnapshot() {
  const q = quotaSnapshot();
  const stale = Object.values(q.providers).some(p => !p.fresh && p.raw.configured !== false);
  // The collector records attempts per provider. A failed/ledger-only probe isn't retried on every dispatch.
  const last = Math.max(0, ...Object.values(q.providers).map(p => p.fetchedAt || 0));
  return refreshQuota({ force: stale && Date.now() - last >= 60000 });
}
export function reservations(q = quotaSnapshot()) {
  const out = [];
  for (const id of (() => { try { return fs.readdirSync(paths.helperJobs); } catch { return []; } })()) {
    const m = read(path.join(paths.helperJobs, id, 'meta.json'));
    if (!q.providers[m.helper]) continue;
    const running = m.status === 'running' && (!m.runnerPid || alive(m.runnerPid));
    const ended = stamp(m.endedAt);
    const confirmed = q.providers[m.helper]?.observedAt >= ended;
    // Keep estimated spend until a newer upstream observation settles it (10-minute fallback for unknown sources).
    const settling = ended && !confirmed && Date.now() - ended < 600000;
    if (running || (m.quotaReservation && settling)) {
      const p = q.providers[m.helper];
      out.push({ helper: m.helper, ...(m.quotaReservation || { cost: expectedCost(p, m), resets: Object.fromEntries(Object.entries(p.windows).map(([k,w]) => [k,w.resetAt])) }) });
    }
  }
  return out;
}
