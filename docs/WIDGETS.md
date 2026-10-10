# 面板卡片（给自己造看板）

面板（http://127.0.0.1/）是一堆**卡片**拼起来的。页面、卡片、数据全由网关提供，前端 `web/index.html` 只负责画。
**任何新功能上线，都要顺手给它做一张卡片**，让主人一眼看到它在不在工作、效果怎么样。

## 什么时候要做卡片

- 做了新插件、新脚本、新定时任务、新服务 → 做一张卡片显示它的状态或产出
- 主人说"面板上加个 xxx" → 做卡片
- 自进化 L2 提案里加了新功能 → 同一个改动里带上卡片

## 两种做法

### 1. 不写代码：JSON 卡片（优先用这个）

写一个 JSON 文件，然后：

```bash
widget lint 卡片.json     # 检查 + 真的取一次数据给你看
widget add  卡片.json     # 放上面板，几秒内出现，不用重启
widget board memory       # 看那一页现在长什么样
widget rm   <id>          # 下架（改名成 .json.off，可恢复）
```

例子：知识库有多少条（放在「记忆」页）

```json
{ "id": "kb.count", "page": "memory", "size": "s", "kind": "stat", "title": "知识库",
  "source": { "type": "count", "dir": "/home/aibox/dsh-work/knowledge", "match": "\\.md$" },
  "map": { "value": "$", "unit": "条" } }
```

例子：你的脚本每次跑完写一个状态文件，卡片直接读它

```json
{ "id": "backup.last", "page": "system", "size": "s", "kind": "stat", "title": "备份",
  "source": { "type": "file", "path": "/home/aibox/.aibox/backup-status.json" },
  "map": { "value": "$.result", "sub": "$.when", "tone": "$.tone" },
  "detailText": "每晚 2 点把 dsh-work 备份到 NAS。失败会变红。" }
```

**数据来源 source.type**

| type | 参数 | 得到 |
|---|---|---|
| `file` | `path`（必须在 /home/aibox 下，≤1MB），`pick`（如 `$.a.b`），`jsonl: true` 取最后一行 | JSON 里的值 |
| `count` | `dir`、`match`（正则）、`recursive` | 文件个数 |
| `metric` | `name`（指标名，如 `turn.done`），`days`（给了就返回每天的序列） | 数字或序列 |
| `events` | `name`（事件类型，如 `stop.done`） | 今天发生了几次 |
| `api` | `name`（网关已有 API，如 `health`），`pick` | API 返回的值 |
| `static` | `data` | 固定内容 |

`map` 把来源的值变成卡片要的形状：`"$"` 是整个值，`"$.a.b"` 取字段，其它原样。
复杂的列表/图表：**让你的脚本直接把卡片要的形状写进文件**，`map` 都不用写。

### 2. 写代码：插件里 `app.widget`

新功能本来就是插件时，在插件的 `setup(app)` 里：

```js
app.widget({ id: 'backup.last', page: 'system', order: 40, size: 's', kind: 'stat', title: '备份',
  data: () => ({ value: '成功', tone: 'good', sub: '2 点' }),
  detail: () => ({ sections: [{ title: '最近 7 次', kind: 'list', data: { items: [...] } }] }) });
app.badge('system', () => 失败了 ? 1 : null);   // 可选：导航上的小角标
```

`data()` 返回 `null` = 这张卡现在不显示（例如「需要你」没事时）。报错只影响这一张卡。

## 卡片类型 kind 和数据形状

| kind | 用途 | data |
|---|---|---|
| `stat` | 一个大数字 | `{ value, unit?, sub?, tone?, delta?: {dir:'up'/'down', good} }` |
| `ring` | 百分比圆环 | `{ pct: 0~1, sub?, tone? }` |
| `meters` | 几条进度条 | `{ items: [{ label, pct: 0~100, text, tone?, sub?, resetAt?, layers? }], foot? }`；`resetAt`（毫秒时间戳）会显示每秒走的倒计时；`windows: [{ k:'5h', left:0~100, tone, resetAt?, pace?, limit? }]` 画成一组紧贴的细条（一个时间窗口一根，limit 那根加粗，pace 画匀速参考竖线），适合同一个额度的多个时间窗口 |
| `bars` | 按天的柱状图 | `{ items: [{ x, a, b?, line?: 0~1, tip? }], legend?: ['a 的名字','b 的名字','线的名字'] }` |
| `list` | 列表 | `{ items: [{ icon?, title, sub?, badge?, tone?, href? }], empty? }` |
| `feed` | 时间线 | `{ items: [{ t, icon?, text, tone? }], empty? }` |
| `chips` | 一排标签 | `{ items: [{ text, tone? }] }` |
| `kv` | 键值表 | `{ items: [{ k, v }] }` |
| `rails` | 参数在范围里的位置 | `{ items: [{ label, min, max, base, value, text, moved? }] }` |
| `note` | 一段话 | `{ text }` |
| `hero` | 大主卡（工人专用） | 见 plugins/board.mjs |

`tone`：`good` 绿 · `warn` 黄 · `bad` 红 · `info` 蓝 · `violet` 紫 · `mute` 灰。

## 放在哪、多大

- `page`：`home` 首页 · `worker` 工人 · `memory` 记忆 · `evolve` 进化 · `system` 系统。
  要新开一页：写新 id（如 `"page": "nas"`）并加 `"pageTitle": "NAS", "pageIcon": "grid"`。手机上超过 5 页会收进「更多」。
- `size`：`s` 占 1 格（电脑一行 4 格 / 手机一行 2 格）· `m` 2 格 · `l` 3 格 · `xl` 整行。一行尽量凑满 4 格。
- `order`：越小越靠前。
- `mobile: "hide"`：手机上不显示（很密的表、次要信息）。

## 少字的规矩（主人最在意）

0. 不用 emoji（列表图标位放 emoji 会自动变成状态圆点）；颜色只用来表示好坏，平时是黑白灰。

1. **title ≤ 4 个字**（上限 8），不要标点。
2. 一张卡**一个重点**：一个数字 / 一个状态 / 一张图。
3. `sub` ≤ 12 个字；解释性的话放 `detailText` 或 `detail`（点开才看）。
4. 首页只放「一眼就要知道」的；其它放对应页面。首页不要超过 8 张卡。
5. 用颜色（tone）表达好坏，别写"正常/异常"一堆字。

## 不许

- 卡片里放密码、令牌、完整的微信 id、对话原文
- `file`/`count` 读 /home/aibox 以外的路径
- 为了卡片去改别的功能的逻辑

## 验证

- `widget lint` 通过 + `widget board <页>` 里看到数据
- 想看样子：`node test/dev-dashboard.mjs 8933 --widget 卡片.json`（假环境，不碰真数据），浏览器开 http://127.0.0.1:8933/
- 做完用一句话告诉主人：「面板『系统』页加了『备份』卡片」
