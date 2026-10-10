// 面板积木：卡片 API、JSON 卡片热加载/校验、/看板、命令行工具
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dsh = async (env) => { await env.say('/dsh'); await env.waitText('已切换'); };

export default [
  {
    name: '面板：每页卡片 + 数据一次拿全，工人空闲/干活两种状态', v1: false,
    async run(env) {
      await dsh(env);
      let b = await env.api('board?page=home');
      assert.deepEqual(b.pages.slice(0, 5).map((p) => p.id), ['home', 'worker', 'memory', 'evolve', 'system']);
      assert.equal(b.widgets[0].id, 'worker');
      assert.equal(b.widgets[0].data.state, 'idle');
      assert.ok(!b.widgets.some((w) => w.id === 'inbox'), '没事时「需要你」不显示');
      await env.say('长任务 #sleep=2500');
      await env.waitFor(async () => (await env.api('board?page=home')).widgets[0].data.state === 'busy', { what: '工人卡变成干活中' });
      b = await env.api('board?page=home');
      assert.equal(b.pages.find((p) => p.id === 'worker').badge, '●');
      const d = await env.api('detail?id=worker');
      assert.ok(d.sections.length >= 1);
      for (const p of ['worker', 'memory', 'evolve', 'system']) assert.ok((await env.api('board?page=' + p)).widgets.length >= 2, p + ' 页有卡片');
    },
  },
  {
    name: '面板：关掉一个功能，它的卡片也跟着消失', v1: false, config: { features: { topics: false } },
    async run(env) {
      const b = await env.api('board?page=memory');
      assert.ok(!b.widgets.some((w) => w.id.startsWith('memory.topics')));
    },
  },
  {
    name: '自己造看板：放一个 JSON 文件，卡片几秒内出现（不重启）；写错的会被挡下并说明', v1: false,
    async run(env) {
      fs.mkdirSync(env.file('dsh-work/knowledge'), { recursive: true });
      for (let i = 0; i < 7; i++) fs.writeFileSync(env.file('dsh-work/knowledge/k' + i + '.md'), 'x');
      env.writeJson('.aibox/widgets/kb.json', { id: 'kb.count', page: 'memory', size: 's', kind: 'stat', title: '知识库', source: { type: 'count', dir: env.file('dsh-work/knowledge'), match: '\\.md$' }, map: { value: '$', unit: '条' } });
      env.writeJson('.aibox/widgets/nas.json', { id: 'nas.used', page: 'nas', pageTitle: 'NAS', size: 's', kind: 'ring', title: 'NAS', source: { type: 'static', data: { pct: 0.42 } } });
      env.writeJson('.aibox/widgets/bad.json', { id: 'Bad Id', page: 'home', kind: 'pie', title: '这是一个特别长的标题啊啊啊', source: { type: 'file', path: '/etc/passwd' } });
      const b = await env.api('board?page=memory');
      const kb = b.widgets.find((w) => w.id === 'kb.count');
      assert.equal(kb.data.value, 7); assert.equal(kb.data.unit, '条');
      assert.ok(b.pages.some((p) => p.id === 'nas' && p.title === 'NAS'), '新页面出现在导航里');
      assert.equal((await env.api('board?page=nas')).widgets[0].data.pct, 0.42);
      const w = await env.api('widgets');
      const bad = w.errors.find((e) => e.file === 'bad.json');
      assert.ok(bad && bad.errors.length >= 4, '坏卡片被挡下：' + JSON.stringify(bad));
      assert.ok(bad.errors.some((e) => e.includes('路径')), '不许读 /home/aibox 以外');
    },
  },
  {
    name: '/看板 描述 → 交给工人按说明书做卡片', v1: false,
    async run(env) {
      await env.say('/看板 显示知识库有多少条');
      await env.waitText('交给工人做卡片');
      await env.waitCalls(1);
      assert.match(env.dshCalls()[0].task, /WIDGETS\.md[\s\S]*widget add/);
      await env.say('/看板');
      await env.waitText('🧩 面板：');
    },
  },
  {
    name: 'widget 命令行：lint 能检查并预览数据，add 放上面板', v1: false,
    async run(env) {
      const f = path.join(env.tmp, 'card.json');
      fs.writeFileSync(f, JSON.stringify({ id: 'demo.static', page: 'home', size: 's', kind: 'stat', title: '演示', source: { type: 'static', data: 5 }, map: { value: '$', unit: '个' } }));
      const run = (...a) => spawnSync(process.execPath, [path.join(env.appDir, 'src/tools/widget.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, AIBOX_HOME: env.home, AIBOX_ROOT: env.root, AIBOX_CONFIG: path.join(env.root, 'config.json') } });
      let r = run('lint', f);
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /"value": 5/);
      r = run('add', f);
      assert.equal(r.status, 0, r.stderr);
      assert.ok((await env.api('board?page=home')).widgets.some((w) => w.id === 'demo.static'));
      fs.writeFileSync(f, '{"id":"x"}');
      r = run('lint', f);
      assert.notEqual(r.status, 0);
    },
  },
];
