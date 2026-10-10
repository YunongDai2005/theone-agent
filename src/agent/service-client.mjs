/** Local DSH RPC and event transport. No model calls or chat policy live here.
 * Protocol verified against installed DSH 0.2.0-rc.2. See docs/DSH-SERVICE.md.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { cfg, paths } from '../core/config.mjs';

export function localBase(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('DSH 服务必须使用本机回环 HTTP 地址');
  return u.origin;
}
export function sessionCookie(base, secret) {
  const authority = new URL(base).host, issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600000 })).toString('base64url');
  const name = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
  return name + '=v1.' + body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
export function readSessionSecret() {
  const text = fs.readFileSync(cfg.dshService.credentialsFile || paths.credentials, 'utf8');
  let doc;
  if (text.trimStart().startsWith('{')) doc = JSON.parse(text);
  else { const require = createRequire(fs.realpathSync(cfg.dshBin)); doc = require('js-yaml').load(text); }
  const r = doc?.records?.['client-connection/browser-session'];
  if (r?.kind !== 'grant' || r.payload?.version !== 1) throw new Error('DSH 浏览器签名凭据未初始化');
  const b = Buffer.from(r.payload.secret || '', 'base64url');
  if (b.length !== 32) throw new Error('DSH 浏览器签名凭据格式不匹配');
  return b;
}
const timeout = (ms) => AbortSignal.timeout(ms);
export class DshServiceClient extends EventEmitter {
  constructor({ base = cfg.dshService.base, secret = readSessionSecret, retryMs = 1000 } = {}) {
    super(); this.base = localBase(base); this.secret = secret; this.retryMs = retryMs;
    this.watches = new Map(); this.streams = new Map(); this.connected = false; this.closed = false;
  }
  cookie() { return sessionCookie(this.base, typeof this.secret === 'function' ? this.secret() : this.secret); }
  async rpc(method, request, { signal = timeout(8000), requestId } = {}) {
    const rpcId = requestId || crypto.randomUUID();
    const args = method === '$events/result' ? request : method === 'session/list' ? { _request: request } : { request };
    const r = await fetch(this.base + '/api/' + method, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', cookie: this.cookie() },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
    if (!r.ok) throw Object.assign(new Error('DSH HTTP ' + r.status), { code: 'HTTP_' + r.status });
    const j = await r.json();
    if (j.type !== 'server-response' || j.rpcId !== rpcId || !j.result) throw new Error('DSH RPC 响应格式不匹配');
    if (!j.result.ok) throw Object.assign(new Error(j.result.error?.message || 'DSH RPC 失败'), { code: j.result.error?.code });
    return j.result.value;
  }
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = new Promise((resolve, reject) => {
      let done = false;
      const u = new URL('/api/remote.mux', this.base); u.protocol = 'ws:';
      const ws = this.socket = new WebSocket(u, { headers: { cookie: this.cookie() } });
      const t = setTimeout(() => { ws.close(); finish(new Error('DSH 事件连接超时')); }, 8000);
      const finish = (e) => { if (done) return; done = true; clearTimeout(t); e ? reject(e) : resolve(); };
      ws.addEventListener('open', () => {
        this.streams.clear();
        this.open('$events', { args: {} }, { events: true });
        for (const sid of this.watches.keys()) this.openFollow(sid);
      });
      ws.addEventListener('message', ({ data }) => {
        let j; try { j = JSON.parse(data); } catch { return; }
        const stream = this.streams.get(j.streamId); if (!stream) return;
        if (j.type === 'item') {
          const v = j.value;
          if (stream.events) {
            if (v?.type === 'ready') { this.clientId = v.clientId; this.connected = true; finish(); this.emit('connection', true); }
            else if (v?.type === 'waterfall') this.emit('request', { ...v, clientId: this.clientId });
            else if (v?.type === 'cancel') this.emit('request-cancel', v);
          } else {
            for (const fn of this.watches.get(stream.sid) || []) { try { fn(v); } catch (e) { this.emit('fault', e); } }
          }
        } else if (j.type === 'end' || j.type === 'error') {
          this.streams.delete(j.streamId);
          if (stream.events) ws.close();
          else if (j.type === 'error' && j.error?.code === 'session/not-found') {
            for (const fn of this.watches.get(stream.sid) || []) fn({ type: 'error', error: j.error });
          } else if (this.watches.has(stream.sid)) {
            const retry = setTimeout(() => { if (this.socket === ws && ws.readyState === WebSocket.OPEN) this.openFollow(stream.sid); }, 1000); retry.unref();
          }
        }
      });
      const ended = () => {
        if (this.socket !== ws) return;
        const wasConnected = this.connected; this.connected = false; this.clientId = null;
        finish(new Error('DSH 事件连接中断'));
        if (wasConnected) this.emit('connection', false);
        if (!this.closed && this.watches.size && !this.retryTimer) {
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect().catch(() => {}); }, this.retryMs);
          this.retryTimer.unref();
        }
      };
      ws.addEventListener('close', ended); ws.addEventListener('error', () => { ws.close(); ended(); });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }
  open(endpoint, payload, meta) {
    const streamId = crypto.randomUUID(); this.streams.set(streamId, meta);
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
    return streamId;
  }
  openFollow(sid) {
    if (this.socket?.readyState !== WebSocket.OPEN || [...this.streams.values()].some(x => x.sid === sid)) return;
    this.open('session/follow', { args: { request: { address: { kind: 'session', sessionId: sid }, maxMessages: 500, assistantStream: true } } }, { sid });
  }
  async watch(sid, fn) {
    const set = this.watches.get(sid) || new Set(); set.add(fn); this.watches.set(sid, set);
    try { await this.connect(); this.openFollow(sid); }
    catch (e) { this.unwatch(sid, fn); throw e; }
    return () => this.unwatch(sid, fn);
  }
  unwatch(sid, fn) {
    const set = this.watches.get(sid); set?.delete(fn);
    if (set?.size) return;
    this.watches.delete(sid);
    for (const [id, x] of this.streams) if (x.sid === sid) {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId: id }));
      this.streams.delete(id);
    }
  }
  async stop(sid) {
    // Cancellation alone preserves queued input in DSH. Remove every pending item first.
    let failure;
    try {
      const p = await this.rpc('session/projections', { sessionId: sid });
      const inbox = p?.values?.inbox;
      if (inbox && (!Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step']))) throw new Error('DSH inbox 协议不匹配');
      for (const m of [...(inbox?.['next-turn'] || []), ...(inbox?.['next-step'] || [])]) {
        try { await this.rpc('session/updateQueue', { sessionId: sid, itemId: m.id, action: { kind: 'remove' } }); }
        catch (e) { if (e.code !== 'session/queue-item-not-found') throw e; }
      }
    } catch (e) { failure = e; }
    try { await this.rpc('session/cancel', { sessionId: sid }); }
    catch (e) { if (e.code !== 'session/not-found') failure ||= e; }
    if (failure) throw failure;
    // cancel is admission only. Confirm the durable turn boundary and empty inbox.
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const p = await this.rpc('session/projections', { sessionId: sid });
      if (p === null) return true;
      const inbox = p?.values?.inbox, boundary = p?.values?.turnBoundary;
      const empty = inbox && Array.isArray(inbox['next-turn']) && Array.isArray(inbox['next-step']) && !inbox['next-turn'].length && !inbox['next-step'].length;
      if (empty) {
        // Installed rc.2 exposes runtime running via list; turnBoundary is optional by deployment.
        if (boundary?.openTurnStartSeq === null) return true;
        if (boundary === undefined) {
          const listed = await this.rpc('session/list', {});
          const item = (Array.isArray(listed) ? listed : listed?.items || []).find(x => x.sessionId === sid);
          if (item?.running === false) return true;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('DSH 取消后尚未确认任务关闭');
  }
  close() { this.closed = true; clearTimeout(this.retryTimer); this.socket?.close(); }
}
let singleton;
export const serviceClient = () => singleton ||= new DshServiceClient();
