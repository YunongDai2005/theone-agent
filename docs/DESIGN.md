# Design

Why The One is shaped the way it is, how interruptions are handled, and where it is going. Back to the [README](../README.md).

## Goal

> **Users should not have to manage sessions. The system should keep their tasks separate, preserve context, and follow through.**

A single conversation can contain several ongoing projects. A dedicated Session Administrator should find the right existing context or create a new session. The Manager should coordinate tasks and advisors within that context.

### The experience we are building toward

*Illustrative interaction, not a recorded demo:*

```text
You:      Help me prepare the website launch.
Manager:  I'll help prepare the launch.

You:      Back to the Python tool we discussed yesterday: add CSV export.
Manager:  I'll add CSV export to the Python tool.

You:      Also include column headers.
Manager:  I'll attach that requirement to the CSV export task.

You:      How is the website going?
Manager:  [Reports the website task's actual state.]
```

The user stays in one chat. Behind it, the system keeps track of:

- **Conversation identity:** continue an existing topic or create a new one.
- **Message intent:** a follow-up, correction, stop request, status question, or separate task.
- **Execution state:** what is running, waiting, completed, or blocked.
- **Context continuity:** which session, handoff, and prior decisions a worker needs.

This is the direction of the project. The dedicated Session Administrator, hierarchical advisor archives, durable scheduling, and independent concurrent topic execution are roadmap work.

## Capabilities in detail

| Capability | Current implementation |
| --- | --- |
| Automatic session routing | Topic matching uses lexical/entity candidates and model judgment to stay in a session, resume another topic, or create one. |
| Conversation during execution | While the worker is busy, the Manager can answer status questions, relay notes, queue another request, or request interruption. |
| Interruptions and corrections | The Manager distinguishes conflicting or urgent changes from compatible additions. Revisions wait for confirmed worker exit, preserve prior requirements and unread additions, and reject decisions tied to an outdated run. |
| Context handoffs | Session metadata, handoff documents, and recall hooks help carry context into another session. |
| Media handling | The WeChat adapter handles text, voice transcripts, images, and file delivery. |
| Quota-aware advisor scheduling | Helper auto-selection filters unavailable or nearly exhausted providers, then asks a Manager model to choose using task difficulty, remaining quota, reset windows, and usage preferences. A rule-based fallback handles unavailable Manager responses. |
| Quota-aware execution routing | Before each turn the main worker picks Go, WorkBuddy, or DeepSeek from one shared quota policy (safety reserves, in-flight reservations, near-reset priority, concurrency caps), with a two-tier fallback when a route fails. A reading past its reset time is shown as "reset pending" until a fresh reading confirms it. |
| Resident worker mode (optional) | With `dshTransport: "service"`, the gateway drives a long-running local DSH service. Compatible additions are steered into the worker's next step instead of restarting the turn; native questions and tool approvals are relayed to the chat; orphaned runs are cleaned up on restart. |
| Delivery receipts | Manager notes move through `pending → accepted → delivered → applied` in an append-only ledger, so a note that was only accepted is never reported as handled. |
| Modular dashboard | Each feature registers its own cards (`app.widget`). JSON cards placed in `~/.aibox/widgets/` load without a restart. `web/index.html` renders desktop and mobile layouts from `GET /api/v2/board`. |
| Optional helper workers | Scripts can invoke additional model/CLI helpers, including worktree-based code tasks. |
| Optional review and improvement | Signals, bounded parameter tuning, and proposed code changes with approval and deployment steps. |
| Replay testing | Fake messaging, worker, and model services exercise the gateway without real accounts. |

### Current boundaries

- **The Manager is not yet the universal entry point.** It primarily handles messages while the worker is busy; ordinary topic routing is a separate stage in the execution pipeline.
- **Execution is serial per chat.** Multiple topic sessions exist, but independent topics in one chat do not yet execute concurrently through the main queue.
- **The local queue is in memory.** Service mode cleans up orphaned worker runs and Manager notes carry delivery receipts, but accepted tasks are not yet persisted and replayed after a restart.
- **New Manager notes carry chat, run, and topic bindings.** Scoped workers read their own notes; deferred delivery waits for the matching foreground topic. Legacy unbound notes and global question files still need migration before broader multi-user use.
- **This is a source release for integration.** Real deployment requires your own DSH configuration, OpenClaw WeChat plugin, accounts, and model access.

## Interruption policy

While the Manager is enabled, it compares new instructions with the current task and execution step. Conflicting requirements or constraints that must apply immediately trigger interruption and a revised continuation. Compatible additions go to the mailbox; agreement and status questions do not restart work. Independent requests are queued for topic routing.

A replacement starts only after the target worker process has exited. Completed side effects are not rolled back. If the run changes while a decision is pending, the system asks for clarification rather than applying it to another run. Model classification is still fallible; the replay tests validate handling of simulated decisions, not real-model accuracy. The legacy steering path remains available when the Manager is disabled.

## Architecture

The current transport path:

```text
WeChat <--> Tencent iLink <--> The One gateway <--> OpenClaw WeChat plugin
                                     |
                         Commands and ingress handlers
                                     |
                      +--------------+--------------+
                      |                             |
              Manager when busy              Per-chat queue
                      |                             |
            Reply / note / redirect           Topic routing
                      |                             |
                      +----------------------> Session context
                                                    |
                                                DSH worker
                                                    |
                                         Reply and state updates
```

WeChat provides the current entry point. The core product idea is **conversation and session orchestration**; the planned separation of responsibilities is described below.

## Planned roles and memory hierarchy

**Design proposal; this complete flow is not implemented yet.** The existing topic router and model judge are the starting point for the Session Administrator.

| Role | Responsibility |
| --- | --- |
| Session Administrator | Find the relevant conversation, resolve references and pending answers, and propose session reuse or creation. Index advisor findings under their parent tasks. |
| Manager | Interpret the requested action within the assigned context, coordinate execution, and choose advisors using task needs, quotas, reset windows, and user preferences. |
| Workers and advisors | Execute scoped tasks and return findings, artifacts, and verification evidence. |
| Runtime | Validate IDs and permissions, persist state, enforce resource constraints, and apply session or execution changes. |

```text
User topic
  └─ Task
      ├─ Main worker session and handoffs
      ├─ Advisor job → session, findings, artifacts, verification
      └─ Advisor job → session, findings, artifacts, verification
```

Advisor jobs should receive their topic and task IDs when created. Their archive destination is determined by those IDs; AI helps summarize and retrieve the records. An advisor suggestion, a verified result, and a merged change remain distinct states. Provider changes use handoff summaries when sessions cannot be resumed across tools.

Switching the foreground conversation must not implicitly stop a running task. Consequential ambiguity should trigger a short clarification. Runtime validation and durable task records must support these decisions before broader autonomous scheduling.

## Roadmap

The priorities follow the single-chat experience:

- [ ] **Dedicated Session Administrator:** resolve current, previous, or new sessions using topic summaries, task state, and pending questions; retain direct handling for explicit stop requests.
- [ ] **Manager coordination:** consume validated session assignments and coordinate tasks and advisors without repeating the routing decision.
- [ ] **Advisor continuity and archives:** bind advisor sessions, findings, artifacts, and verification status to their parent tasks; resume compatible sessions or provide a handoff summary.
- [ ] **Explicit task binding:** associate notes, corrections, questions, and results with a conversation, topic, and task ID.
- [ ] **Durable scheduling:** persist accepted tasks and delivery state; recover safely after restarts and avoid duplicate execution.
- [ ] **Ambiguity handling:** use task state and recent references to resolve follow-ups; ask a short clarification when a consequential choice remains unclear.
- [ ] **Independent topic execution:** allow bounded concurrency across unrelated sessions while serializing work that shares context or resources.
- [ ] **Routing evaluation:** add labeled replay cases for topic switches, next-day continuations, interruptions, corrections, and ambiguous references.
