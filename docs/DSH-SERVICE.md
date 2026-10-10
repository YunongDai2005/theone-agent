# 常驻工人和中途讨论

## 用户体验

- 照常在微信发任务，工人在常驻 DSH 中执行，面板订阅工具和说明事件。
- 兼容的补充由经理转入 `session/prompt mode=steer`，DSH 在下一步接入；不会重启整轮。
- 冲突或必须立即生效的指令仍先取消旧执行、确认关闭，再带新要求继续。中断不会撤销已完成的操作。
- 原生 `ask_user_question` 转到当前微信聊天。选项名或编号直接回复，自由回答也可由经理判断；明确指定用 `/回答 编号 内容`。
- 工具审批必须 `/通过 编号` 或 `/拒绝 编号`，普通“好”不算授权。
- 等主人回答时暂停无输出看门狗；30 分钟未答会停止任务，不自动同意。

顾问保留四路：Codex、Claude Code、Go、WorkBuddy 反代。DSH 主工人三条执行线路与四路顾问分开管理。经理和顾问卡片会按实际通道标注 WorkBuddy。

## 回执口径

`mailbox.jsonl` 记录留言原文；`delivery.jsonl` 只追加状态事件，各进程不会互相覆盖。

| 状态 | 可以确认什么 |
| --- | --- |
| pending | 网关已保存留言，尚未确认送入 DSH |
| accepted | DSH RPC 已接受；不能等同于工人已处理 |
| delivered | 观察到对应 requestId 的 durable `user/message`，工人已接入该输入 |
| cancelled | 主人叫停，未送达的补充已取消，不自动补交 |
| applied | 工人执行 `mailbox --ack 编号 --session 会话ID`，报告已处理 |

`applied` 是工人的确认，不是程序独立证明其实现正确。仍需查看结果与验证。

查询：`GET /api/v2/deliveries`，工人页“补充”卡片。原文不放入公共回执 API。

`mailbox` 阅读不自动确认处理。只有已送达当前会话的编号可以 `--ack`。

叫停会同时清除当前聊天中未开始的本地排队任务，以及 DSH 的待接入输入。

## 实现

- `agent/service-client.mjs`：本机 Cookie 鉴权、RPC、remote.mux、重连重订阅、清 inbox 后 cancel。
- `agent/service-runner.mjs`：对应一个逻辑任务的事件、requestId 去重、下一步补充、关闭确认、孤儿任务恢复。
- `plugins/interaction.mjs`：按 chat/runId/eventId 绑定的微信问答和审批、等待卡片。
- `manager/receipts.mjs`：单独的追加式回执账本。
- `plugins/manager.mjs`：保留关系判断，补充优先原生 steer；失败保存在信箱，空闲补交不会提前标读。

`dshTransport: service` 使用常驻服务；`headless` 为原 CLI 路径。先建立事件快照再投递请求。
旧快照只用于恢复状态，已处理 seq 不再转发。断线后重订阅并恢复新事件；不会因为投递回执丢失就盲目重跑任务。

`~/.aibox/mgr/service-runs.json` 记录网关拥有的服务任务。网关重启时先清理上次未结束的任务，再接受新任务；无法确认清理时拒绝启动，防止后台继续执行。

服务 `aibox-dsh.service` 仅听 127.0.0.1:3081，profile 为 gateway。模型与工具配置继承原 headless 用户 patch 并组合 web 服务层，逐会话选择 Go/WorkBuddy/DeepSeek，保留原回落顺序。

回滚：停下并确认当前 DSH 任务结束，将 config.json 的 dshTransport 改为 headless，重启 wx-router；确认 service-runs.json 为空再停止 aibox-dsh。不要重启 openclaw-gateway。

## 来源与验证

参考 Derpyu520/qq-bridge commit `9df6a7e7fc5abcb36793337f778483bd442a3d2d`：
- local browser-session Cookie 的协议格式；
- remote.mux/session-follow 快照与事件分离；
- 先清 inbox 再取消任务、按请求回执删除挂起问题。

此处独立实现传输和网关集成，不引入 SnowLuma/QQ 依赖。协议同时核对了本机 DSH 0.2.0-rc.2 源码。

本地回放覆盖原路由与常驻服务；真实 DSH 探针使用隔离测试任务验证下一步补充和原生问题往返。没有冒充主人向真实微信注入测试消息。
