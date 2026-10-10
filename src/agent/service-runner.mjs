/** Executes one owned DSH turn, keeping RPC admission separate from durable consumption. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { cfg, paths } from '../core/config.mjs';
import { readJson, writeJson } from '../core/store.mjs';
import { log, emit, tag } from '../core/log.mjs';
import { serviceClient } from './service-client.mjs';
import { receipt } from '../manager/receipts.mjs';

const JOURNAL = path.join(paths.mgr, 'service-runs.json');
const sessions = new Map();
let prepared;
function journal(id, value) {
  const j = readJson(JOURNAL, {});
  if (value) j[id] = value; else delete j[id];
  writeJson(JOURNAL, j); fs.chmodSync(JOURNAL, 0o600); // private metadata only, no prompts or credentials
}
export async function prepareService() {
  if (cfg.dshTransport !== 'service') return;
  return prepared ||= (async () => {
    const client = serviceClient();
    // A router restart must not leave a detached DSH task working invisibly.
    for (const [id, r] of Object.entries(readJson(JOURNAL, {}))) {
      await client.stop(r.sessionId);
      journal(id, null);
      emit('dsh.recovered', { chat: tag(r.chat), cancelled: true });
    }
  })();
}
export function serviceState() {
  return { enabled: cfg.dshTransport === 'service', connected: cfg.dshTransport === 'service' && serviceClient().connected,
    running: [...sessions.values()].map(x => ({ sessionId: x.sessionId, runId: x.runId, waiting: !!x.pendingRequest, chat: tag(x.chat) })) };
}
function textOf(content) { return (content || []).filter(x => x.type === 'text').map(x => x.text || '').join('\n'); }
export async function runService(task, sid, opts = {}) {
  await prepareService();
  const client = serviceClient(), t0 = Date.now(), runId = opts.runId || crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const route = opts.fallback === 2 ? 'deepseek' : opts.fallback ? 'workbuddy' : 'go';
  let sessionId = sid, accepted = false, submitted = false, ended = false, settled = false;
  let lastAt = t0, disconnectedAt = 0, final = '', usage = 0, usagePeak = 0, ctxFill = 0, killedBy = null, errTail = '';
  let lastSeq = -1, baseline = false, currentTurn = null, sawInput = false, stepUsage = null;
  let cleanupWatch, timer, registration, waitPaused = 0, waitingSince = 0;
  const deliveries = new Map([[requestId, opts.receiptIds || []]]);
  const consumedRequests = new Set();
  let pendingTerminal, lastHeartbeat = t0;
  let resolveEnd; const endedPromise = new Promise(r => { resolveEnd = r; });
  let resolveResult; const resultPromise = new Promise(r => { resolveResult = r; });
  const control = {
    runId, generation: opts.generation, task, chat: opts.chat || '', state: 'running', startedAt: t0,
    transport: 'service', get hasClosed() { return ended; }, get sessionId() { return sessionId; }, pendingRequest: null,
    clearRequest() {
      control.pendingRequest = null;
      if (waitingSince) { waitPaused += Date.now() - waitingSince; waitingSince = 0; }
      lastAt = Date.now();
    },
    async steer(item) {
      if (settled || ended || !registration.isCurrent(runId)) return false;
      const id = 'aibox-note-' + item.id;
      deliveries.set(id, [item.id]);
      // Stable requestId makes response-loss retries idempotent on the DSH side.
      receipt([item.id], 'pending', { sessionId, requestId: id, runId });
      try { await client.rpc('session/prompt', { sessionId, requestId: id, mode: 'steer', clientTimeZone: 'Asia/Shanghai',
        content: [{ type: 'text', text: '【主人中途补充，编号 ' + item.id + '】\n' + item.text + '\n按这条调整当前任务。完成调整后执行 mailbox --ack ' + item.id + ' --session ' + sessionId + '，再报告实际改变。' }] }); } catch (e) {
        if (e.code) { deliveries.delete(id); if (pendingTerminal) finishTerminal(pendingTerminal); }
        throw e;
      }
      receipt([item.id], 'accepted', { sessionId, requestId: id, runId });
      emit('mailbox.accepted', { chat: tag(control.chat), id: item.id });
      return true;
    },
    async interrupt(expected = runId) {
      if (expected !== runId || !registration.isCurrent(runId)) return false;
      registration.invalidate(runId); control.state = 'stopping'; killedBy = 'interrupt';
      return stopOwned();
    },
  };
  registration = opts.register ? opts.register(control) : { isCurrent: () => true, invalidate: () => true, ownsRunId: () => true, unregister: () => {} };
  function report(j) { if (registration.isCurrent(runId)) opts.onEvent?.(j); }
  function finish({ code = 0, signal = null, stale = false } = {}) {
    if (settled) return; settled = true; clearInterval(timer); cleanupWatch?.();
    client.off('request', onRequest); client.off('request-cancel', onRequestCancel); client.off('connection', onConnection);
    control.clearRequest(); sessions.delete(sessionId);
    if (!submitted || ended) { journal(runId, null); control.state = 'closed'; registration.unregister(runId); }
    else control.state = 'stopping'; // no confirmed teardown: retain ownership + journal
    resolveResult({ code, signal, killedBy, interrupted: killedBy === 'interrupt', stale, runId, generation: opts.generation,
      sessionId, final, usage, usagePeak, ctxFill, took: Date.now() - t0, errTail, fallback: !!opts.fallback, accepted, transport: 'service' });
  }
  async function stopOwned() {
    try {
      const confirmed = await client.stop(sessionId);
      if (confirmed) { ended = true; resolveEnd(); }
      // We must observe the closed turn; cancelling an HTTP request is not cancelling work.
      if (!ended) await Promise.race([endedPromise, new Promise(r => setTimeout(r, 10000))]);
      if (!ended && !sawInput) {
        const p = await client.rpc('session/projections', { sessionId });
        const inbox = p?.values?.inbox;
        const busy = p?.values?.status;
        // Absence is safe only for a request never admitted; otherwise require turn/end.
        if (!submitted && !inbox && !busy) ended = true;
      }
      return ended;
    } catch (e) { errTail = '取消未确认：' + e.message; return false; }
  }
  function onConnection(connected) { disconnectedAt = connected ? 0 : (disconnectedAt || Date.now()); }
  function onRequest(q) {
    if (q.agentId !== sessionId || settled || !registration.isCurrent(runId)) return;
    if (!['user-questions/request', 'approval/request'].includes(q.event)) return;
    if (control.pendingRequest?.eventId === q.eventId) return;
    control.pendingRequest = { ...q, chat: control.chat, runId, at: Date.now() };
    if (!waitingSince) waitingSince = Date.now();
    report({ type: 'waiting', label: q.event === 'approval/request' ? '等你确认' : '等你回答' });
    opts.onRequest?.(control.pendingRequest);
  }
  function onRequestCancel(q) {
    if (control.pendingRequest?.eventId === q.eventId) control.clearRequest();
  }
  function consume(e) {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq <= lastSeq) return;
    lastSeq = e.seq; lastAt = Date.now();
    const d = e.data || {};
    if (e.type === 'user/message') {
      const sourceId = d.source?.rpcId;
      if (sourceId) consumedRequests.add(sourceId);
      if (sourceId === requestId) sawInput = true;
      const ids = deliveries.get(sourceId);
      if (ids?.length) {
        const newly = receipt(ids, 'delivered', { sessionId, requestId: sourceId, runId });
        if (newly.length) opts.onReceipt?.({ ids: newly.map(x => x.id), state: 'delivered', chat: control.chat });
      }
    }
    if (e.type === 'turn/start') { currentTurn = d.turn; final = ''; report({ type: 'status', phase: 'turn_start', turn: d.turn }); }
    else if (e.type === 'step/start') { stepUsage = null; report({ type: 'status', phase: 'step_start', step: d.step, turn: d.turn }); }
    else if (e.type === 'assistant/message') {
      final = textOf(d.message?.content);
      for (const b of d.message?.content || []) {
        if (b.type === 'text') report({ type: 'text', text: b.text });
        // Reasoning is not copied to public dashboards or WeChat.
      }
      stepUsage = d.usage || [...(d.stream || [])].reverse().find(x => x.usage)?.usage;
    } else if (e.type === 'step/end') {
      if (stepUsage) {
        const it = (stepUsage.inputTokens || 0) + (stepUsage.cacheReadTokens || 0) + (stepUsage.cacheWriteTokens || 0);
        usage += it; usagePeak = Math.max(usagePeak, it); ctxFill = it;
      }
      report({ type: 'status', phase: 'step_end', usage: stepUsage, turn: d.turn, step: d.step });
    } else if (e.type === 'tool/call') {
      let input = {}; try { input = JSON.parse(d.arguments || '{}'); } catch {}
      report({ type: 'tool_call', tool: d.name, callId: d.callId, input });
    } else if (e.type === 'tool/result' && e.surfaceOp === 'append') {
      report({ type: 'tool_result', callId: d.message?.toolCallId, status: d.message?.isError ? 'error' : 'completed' });
    } else if (e.type === 'turn/end' && currentTurn === d.turn && (sawInput || killedBy)) {
      pendingTerminal = d;
      finishTerminal(d);
    }
  }
  function finishTerminal(d) {
    // An admission in flight at turn/end can land in a following native turn.
    // Keep supervising it instead of closing the watch and leaving hidden work.
    const pending = [...deliveries.keys()].some(id => !consumedRequests.has(id));
    if (!killedBy && d.reason?.kind === 'completed' && pending) return;
    ended = true; resolveEnd();
    const complete = d.reason?.kind === 'completed';
    if (!complete) { final = ''; errTail = JSON.stringify(d.reason || {}); }
    finish({ code: complete ? 0 : 1, stale: killedBy === 'interrupt' });
  }

  let feeding = Promise.resolve();
  function feed(v) {
    // Real DSH history records wrap events; websocket live frames are already unwrapped.
    // Replay backwards pages through the snapshot cursor before handling buffered live frames.
    feeding = feeding.then(async () => {
      if (settled) return;
      if (v?.type === 'snapshot') {
        let records = v.records || [];
        if (!baseline) {
          baseline = true;
          lastSeq = Number.isSafeInteger(v.cursor) ? v.cursor : Math.max(-1, ...records.map(x => (x.event || x).seq).filter(Number.isSafeInteger));
          resolveBaseline?.();
        } else {
          let hasMore = v.hasMore;
          let oldest = Math.min(Infinity, ...records.map(x => (x.event || x).seq));
          while (hasMore && oldest > lastSeq + 1) {
            const page = await client.rpc('session/page', { address: { kind: 'session', sessionId }, throughSeq: v.cursor, beforeSeq: oldest, maxMessages: 500 });
            const previous = page.records || [];
            const nextOldest = Math.min(Infinity, ...previous.map(x => (x.event || x).seq));
            if (!previous.length || nextOldest >= oldest) throw new Error('DSH 重连历史没有前进');
            records = [...previous, ...records]; oldest = nextOldest; hasMore = page.hasMore;
          }
          for (const r of records) consume(r.event || r);
        }
      } else if (baseline && v?.type === 'event') consume(v.event);
      else if (v?.type === 'assistant-stream') {
        lastAt = Date.now();
        if (lastAt - lastHeartbeat >= 3000) { lastHeartbeat = lastAt; report({ type: 'status', phase: 'activity' }); } // heartbeat only; never publish reasoning content
      }
      else if (v?.type === 'error') throw new Error(v.error?.code || '会话事件错误');
    }).catch(async e => {
      if (settled) return;
      errTail = e.message;
      if (submitted) await stopOwned();
      finish({ code: 1, signal: submitted ? 'CONNECTION_LOST' : null });
    });
  }
  let resolveBaseline; const baselinePromise = new Promise(r => { resolveBaseline = r; });
  try {
    const created = await client.rpc('session/create', { ...(sid ? { sessionId: sid } : {}), cwd: cfg.dshCwd });
    sessionId = created.sessionId; sessions.set(sessionId, control);
    report({ type: 'session', sessionId });
    await client.rpc('session/selectModel', { sessionId, ...cfg.dshService.routes[route] });
    client.on('request', onRequest); client.on('request-cancel', onRequestCancel); client.on('connection', onConnection);
    cleanupWatch = await client.watch(sessionId, feed);
    await Promise.race([baselinePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('DSH 会话快照超时')), 8000))]);
    if (!registration.isCurrent(runId)) { ended = true; finish({ stale: true }); return resultPromise; }
    journal(runId, { sessionId, chat: control.chat, requestId, at: Date.now() });
    submitted = true;
    await client.rpc('session/prompt', { sessionId, requestId, mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: task + ((opts.receiptIds || []).length ? '\n处理并验证这些补充后执行 mailbox --ack ' + opts.receiptIds.join(',') + ' --session ' + sessionId + '，再报告实际改变。' : '') }] });
    accepted = true;
    receipt(opts.receiptIds || [], 'accepted', { sessionId, requestId, runId });
    // Headless also calls this only after its session event; no receipt is issued for mere local queuing.
    opts.onSubmitted?.({ sessionId, requestId });
    timer = setInterval(async () => {
      if (settled || control.state !== 'running') return;
      const now = Date.now();
      const waiting = waitingSince ? now - waitingSince : 0;
      const reason = disconnectedAt && now - disconnectedAt > cfg.dshService.reconnectMs ? 'connection'
        : waiting && waiting > cfg.dshService.questionMs ? 'question'
        : now - t0 - waitPaused - waiting > (opts.timeoutMs || cfg.dshTimeoutMs) ? 'max'
        : !waiting && now - lastAt > (opts.idleMs || cfg.dshIdleMs) ? 'idle' : null;
      if (!reason) return;
      control.state = 'stopping'; killedBy = reason;
      const stopped = await stopOwned();
      if (!settled) finish({ code: 1, signal: stopped ? 'CANCELLED' : 'STOP_UNCONFIRMED' });
    }, opts.tickMs || 1000);
    if (settled) clearInterval(timer);
  } catch (e) {
    errTail = e.code || e.message;
    if (submitted) { const stopped = await stopOwned(); finish({ code: 1, signal: stopped ? 'CANCELLED' : 'STOP_UNCONFIRMED' }); }
    else { ended = true; finish({ code: 1 }); }
  }
  return resultPromise;
}
