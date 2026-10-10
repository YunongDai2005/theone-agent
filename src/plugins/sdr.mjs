/**
 * SDR 卡片：网页上听 SDRplay RSP1。
 *
 * RSP1 是独占设备，同一时刻只能一个进程用。本机还有卫星过境录制（rec_bw）要用它。
 * 所以做成「按需」：想听先开，听完关掉，设备干净还给录制脚本。
 * 开关走微信命令 `/sdr 开` `/sdr 关`（卡片本身只是入口 + 状态，前端没有点击回调）。
 *
 * 实现在宿主：
 *   - 容器镜像 slechev/openwebrxplus:1.2.125（自带 SDRplay API + SoapySDR，与 26.04 宿主零交集）
 *   - systemd 单元 owrx-web.service（Type=oneshot + RemainAfterExit），start/stop 即开/关
 *   - 网页 http://127.0.0.1:8073/
 * 踩坑细节：knowledge/机器与服务/网页听 SDR（OpenWebRX+ 容器，按需启停）.md
 */
import { execFile } from 'node:child_process';
import { log } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';

const UNIT = 'owrx-web';
const PORT = 8073;
const URL = `http://127.0.0.1:${PORT}/`;
const SETTINGS = '/opt/owrx-docker/var/settings.json';

// 可选的频点（id → 显示名）。id 就是 settings.json 里的 profile key。
const PROFILES = {
  'RSP1-945': '94.5 FM',
  'RSP1-FM': 'FM 98',
  'RSP1-137': '137 气象卫星',
  'RSP1-VHF': 'VHF 144-146',
  'RSP1-UHF': 'UHF 430-440',
  'RSP1-SW': '短波 0.5-30M',
};

function sh(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

// 当前选中的频点：读 settings.json 的 default_profile
async function currentProfile() {
  const r = await sh('sudo', ['cat', SETTINGS], 8000);
  try {
    const id = JSON.parse(r.out).default_profile;
    return { id, title: PROFILES[id] || id || '未知' };
  } catch { return { id: null, title: '未知' }; }
}
// 换频点：改 default_profile 再重启容器（实测 ~12s）
async function setProfile(id) {
  const r = await sh('sudo', ['python3', '-c', `
import json
p='${SETTINGS}'
d=json.load(open(p)); d['default_profile']='${id}'
json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)
print('ok')`], 15000);
  if (!r.ok) return { ok: false, message: '改配置失败：' + (r.err || '未知') };
  await sh('sudo', ['chown', 'landscape:uuidd', SETTINGS], 8000);
  // 配置改了要重启容器才生效；开着才重启，关着就下次开的时候生效
  const state = await unitState();
  if (state === 'active') {
    await sh('sudo', ['docker', 'restart', 'owrx'], 90000);
    await new Promise((r2) => setTimeout(r2, 12000));
  }
  log('sdr tune -> ' + id);
  return { ok: true, message: '已切到 ' + (PROFILES[id] || id) };
}

const unitState = async () => (await sh('systemctl', ['is-active', UNIT])).out || 'unknown';
// 等单元到达想要的状态。systemctl start 返回 ≠ 已经 active（还可能是 activating），
// 立刻查状态会读到 inactive 而误判失败 —— 实测踩过，这里必须轮询确认。
async function waitState(want, timeoutMs = 60000) {
  const t0 = Date.now();
  let s = await unitState();
  while (Date.now() - t0 < timeoutMs) {
    s = await unitState();
    if (want === 'active' && s === 'active') return s;
    if (want === 'inactive' && s === 'inactive') return s;
    if (s === 'failed') return s;                 // 已经失败就别等了
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
}
// 卫星录制脚本跑着的时候，SDR 抢不到设备 —— 必须让主人知道，别硬抢
// 注意：用 -x 精确匹配进程名。pgrep -f '关键词' 会匹配到自己这条命令行（老坑）。
const recording = async () => (await sh('pgrep', ['-x', 'rec_bw'])).ok || (await sh('pgrep', ['-x', 'rec_zif'])).ok;
const present = async () => (await sh('lsusb', ['-d', '1df7:2500'])).ok;

async function openSdr() {
  if (await recording()) return { ok: false, msg: '现在有卫星录制在用 RSP1，等它录完再开。' };
  if (!(await present())) return { ok: false, msg: 'RSP1 不在 USB 上，得先插好。' };
  // 必须 sudo（实测踩过：漏了 sudo → 静默失败，还白等 60 秒）
  await sh('sudo', ['systemctl', 'start', UNIT], 90000);
  const state = await waitState('active', 45000);   // 等真起来，别拿 activating 当失败
  log('sdr start -> ' + state);
  return state === 'active'
    ? { ok: true, msg: 'SDR 开好了，点这里听：' + URL }
    : { ok: false, msg: '没起来（' + state + '），面板上看「SDR」卡片详情。' };
}
async function closeSdr() {
  await sh('sudo', ['systemctl', 'stop', UNIT], 90000);
  const state = await waitState('inactive', 60000);
  log('sdr stop -> ' + state);
  return state === 'inactive'
    ? { ok: true, msg: 'SDR 关了，设备还给卫星录制。' }
    : { ok: false, msg: '没停干净（' + state + '），设备可能还被占着。' };
}

export default {
  name: 'sdr', desc: 'SDR 卡片：网页听 RSP1（按需开关）',
  setup(app) {
    app.widget({
      id: 'sdr.radio', page: ['home', 'system'], order: 32, size: 's', kind: 'stat', title: 'SDR', icon: '📻',
      async data() {
        const [state, rec, has] = await Promise.all([unitState(), recording(), present()]);
        const prof = await currentProfile();
        // 不给 href：点开是弹层（里面有播放器 + 开关），不跳到 OpenWebRX
        if (state === 'active') return { value: '在听', tone: 'good', sub: prof.title };
        if (!has) return { value: '没插', tone: 'bad', sub: 'RSP1 不在' };
        if (rec) return { value: '录音中', tone: 'info', sub: '设备被占用' };
        if (state === 'failed') return { value: '起不来', tone: 'bad', sub: '看卡片详情' };
        return { value: '关着', sub: '点开听' };
      },
      async detail() {
        const [state, rec, has] = await Promise.all([unitState(), recording(), present()]);
        const j = await sh('journalctl', ['-u', UNIT, '-n', '4', '--no-pager', '-o', 'cat'], 10000);
        const prof = await currentProfile();
        return {
          sections: [
            // 面板内播放器：开着的时候直接内嵌，不用跳到 OpenWebRX
            ...(state === 'active' ? [{ kind: 'player', data: { url: URL, label: '正在听 ' + prof.title } }] : []),
            { kind: 'actions', data: {
              state, recording: rec, present: has, profile: prof.id,
              profiles: PROFILES,
              note: !has ? 'RSP1 不在 USB 上' : rec ? '卫星录制在用设备，先等它录完' : '',
            } },
            { title: '状态', kind: 'kv', data: { items: [
              { k: '服务', v: state === 'active' ? '开着' : state },
              { k: '当前频点', v: prof.title },
              { k: 'RSP1', v: has ? '在 USB 上' : '不在 USB 上' },
              { k: '卫星录制', v: rec ? '正在用设备' : '空闲' },
            ] } },
            { title: '最近日志', kind: 'note', data: { text: j.out || '（无）' } },
          ],
        };
      },
    });

    // 面板 API：卡片/按钮直接用这些，不用跳转。
    // ⚠️ 开关/选台要 5-15 秒，而面板后端反代 /api/v2/* 只等 4 秒就断（502）。
    //    所以这里一律「立刻返回 + 后台继续做」，前端靠状态自己刷新。
    //    实测踩过：同步等完再返回 → 反代超时 → 前端报错、状态错乱。
    const busy = { start: false, stop: false, tune: false };
    app.api('sdr', async () => ({
      state: await unitState(), recording: await recording(), present: await present(),
      url: URL, profile: await currentProfile(), busy,
    }));
    app.api('sdr.start', async () => {
      if (busy.start) return { ok: true, started: true, message: '正在启动…' };
      busy.start = true;
      openSdr().then((r) => log('sdr start done ok=' + r.ok + ' ' + r.msg))
        .catch((e) => log('sdr start ERROR ' + e.message))
        .finally(() => { busy.start = false; });
      return { ok: true, started: true, message: '正在启动，约 15 秒' };
    });
    app.api('sdr.stop', async () => {
      if (busy.stop) return { ok: true, started: true, message: '正在关闭…' };
      busy.stop = true;
      closeSdr().then((r) => log('sdr stop done ok=' + r.ok + ' ' + r.msg))
        .catch((e) => log('sdr stop ERROR ' + e.message))
        .finally(() => { busy.stop = false; });
      return { ok: true, started: true, message: '正在关闭，约 10 秒' };
    });
    // 选台：改配置里的默认 profile，重启容器生效（实测 ~12 秒）
    // 参数走查询串（/api/v2 是只读 GET 反代，不支持 POST body）
    app.api('sdr.tune', async (q) => {
      const id = String((q && q.get && q.get('profile')) || '');
      if (!PROFILES[id]) return { ok: false, message: '没有这个频点' };
      if (busy.tune) return { ok: true, started: true, message: '正在切换…' };
      busy.tune = true;
      setProfile(id).then((r) => log('sdr tune done ' + id + ' ok=' + r.ok))
        .catch((e) => log('sdr tune ERROR ' + e.message))
        .finally(() => { busy.tune = false; });
      return { ok: true, started: true, message: '正在切到 ' + PROFILES[id] + '，约 15 秒' };
    });

    app.command({
      pattern: /^\/sdr(?:\s*(开|关|on|off))?$/i, names: ['/sdr [开|关]'],
      help: '网页听 SDR（RSP1）：/sdr 开 · /sdr 关 · /sdr 看状态',
      async handle(ctx, m) {
        const word = (m && m[1] || '').toLowerCase();
        if (word === '开' || word === 'on') return wx.replySoft(ctx.msg, (await openSdr()).msg);
        if (word === '关' || word === 'off') return wx.replySoft(ctx.msg, (await closeSdr()).msg);
        const [state, rec, has] = await Promise.all([unitState(), recording(), present()]);
        const line = state === 'active' ? '开着，正在听'
          : !has ? 'RSP1 没插'
            : rec ? '关着，设备正被卫星录制占用'
              : '关着';
        return wx.replySoft(ctx.msg, `📻 SDR：${line}\n/sdr 开 — 开始听\n/sdr 关 — 还给卫星录制\n收听地址 ${URL}`);
      },
    });
  },
};
