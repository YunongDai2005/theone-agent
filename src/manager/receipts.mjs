/** Append-only delivery receipts, shared with the mailbox CLI. A queue claim is not a read receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/config.mjs';
const FILE = path.join(paths.mgr, 'delivery.jsonl');
export const STATES = ['pending', 'accepted', 'delivered', 'applied', 'cancelled'];
export function receipts() {
  const all = new Map();
  try {
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const old = all.get(e.id) || {};
      if (e.state && STATES.indexOf(e.state) < STATES.indexOf(old.state)) continue;
      all.set(e.id, { ...old, ...e });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return all;
}
export function receipt(ids, state, binding = {}) {
  if (!STATES.includes(state)) throw new Error('未知消息回执状态');
  fs.mkdirSync(paths.mgr, { recursive: true });
  const before = receipts(), out = [];
  for (const id of ids) {
    const prev = before.get(id);
    if (prev && STATES.indexOf(state) <= STATES.indexOf(prev.state)) continue;
    const e = { id, ...binding, state, at: new Date().toISOString() };
    fs.appendFileSync(FILE, JSON.stringify(e) + '\n', { mode: 0o600 }); out.push(e);
  }
  return out;
}
