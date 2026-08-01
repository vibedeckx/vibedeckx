# Project Dashboard and Project Chat Design

## Status

Implemented with automated acceptance and a partial real-browser smoke,
2026-08-01. The approved product model and information architecture remain
unchanged. Live model-driven browser acceptance remains incomplete because the
available DeepSeek credential returns 401.

## Implementation reconciliation

Production hardening added the following internal details without changing the
approved Project Chat behavior:

- Accepted turns use a private durable work journal, separate from the public
  transcript, with bounded recovery and global concurrency backpressure.
- State-changing tools use scoped, typed, idempotent operation records. Agent
  Session and Schedule Run updates are correlated only to the originating
  threads, and public operation messages are produced from per-kind DTO
  allowlists rather than exposing internal delivery or transport state.
- Stop uses an ephemeral `activeTurnId` compare-and-stop contract so a delayed
  request cannot stop the next queued turn.
- Manual schedule reruns keep compact immutable outcomes after bulky historical
  run rows are pruned, preserving idempotency without unbounded output storage.
- Remote Agent Sessions are represented in Project Activity by an authorized
  local projection, updated before global refresh events and repaired by a
  bounded catalog refresh. The dashboard still performs one local aggregate
  read rather than browser or server N+1 fan-out.
- Context refs are projected with authorized, discriminated navigation metadata;
  deleted or no-longer-authorized targets remain readable but non-actionable.
- The workbench keeps unsent drafts per project/thread while it remains mounted,
  so thread switches and responsive drawer transitions do not erase input.
- Local no-auth data uses a canonical local owner across projects, remote
  servers, and machine identity. Idempotent migrations normalize legacy blank
  or machine-scoped ownership before scoped reads and writes.
- User-facing project child routes authorize the current principal against the
  parent project, including no-auth local mode. Project-remote mutations require
  both project ownership and association membership.
- Commander read and mutation tools revalidate live project, workspace, remote,
  and entity scope immediately before use. Cached or model-supplied identifiers
  are never sufficient authorization.
- Public runner, provider, tool, and operation errors pass through one bounded
  sanitizer before persistence or broadcast; credentials, internal locations,
  and transport details remain server-only.
- The durable transcript remains complete, while live/WS and model context use
  independent message-count and UTF-8 byte budgets. Older UI messages remain
  available through authorized sequence-cursor pagination.
- Project Chat history uses project/user-scoped stable cursor pagination and
  database-backed title search, so threads beyond the recent window remain
  discoverable without changing the Overview's Recent five.
- Approval actions are driven by the server's current pending-ID set and expire
  on resolution, stop, terminal state, restart, or deletion while their history
  remains readable.

Detailed work-journal, mutation, lifecycle, and durable-effect protocols are
recorded in the companion `2026-07-31-project-chat-*` design and implementation
documents.

## Goal

Turn the project landing page into a project-level operations dashboard and add
a persistent project-scoped chat. The page should answer three questions at a
glance:

1. What is running now?
2. What happened recently?
3. What needs attention?

Project Chat is a coordination surface above individual workspaces. It can
discuss and coordinate work across workspaces, agent sessions, tasks, schedules,
and schedule runs. It is not owned by a branch or workspace.

## Product terminology

- **Project Chat**: the project-level chat feature and workspace.
- **Thread**: one independent Project Chat conversation.
- **Agent Session**: a coding-agent conversation running in a specific
  workspace.
- **Task**: a user-managed project to-do item.
- **Schedule Run**: one execution of a schedule.

Do not introduce a separate Mission entity. A thread may coordinate a large
goal, but that is a use of a thread rather than a distinct product concept.

## Existing behavior and constraints

The current project Home view shows project metadata followed by Tasks and
Workspaces cards. Workspaces are execution context, not the most useful project
outcome to emphasize on a dashboard.

The existing Main Chat is scoped to `project + branch`: its route and frontend
hook create or retrieve a chat session using both values. It therefore cannot
be relabeled and reused as Project Chat without changing its identity and
storage model.

Existing agent-session listing is branch-oriented, and existing schedule-run
listing is schedule-oriented. Building a project dashboard by querying every
workspace and schedule from the browser would cause N+1 requests. The project
dashboard needs a project-level activity read model.

## Information architecture

### Project Overview

The project Overview remains the landing page. Its visual hierarchy is:

```text
+------------------------------------------------------+
| Project name                         Running / Failed |
+------------------------------------------------------+
| Project Chat                                         |
| [ Discuss the project...                    ] [Send] |
| Recent threads: ...                       View all -> |
+-------------------------------+----------------------+
| Recent Agent Sessions         | Schedule Results     |
+-------------------------------+----------------------+
| Priority Tasks                | Attention Required   |
+-------------------------------+----------------------+
```

Cards have explicit hierarchy rather than equal visual weight. Project Chat is
the primary action. Recent Agent Sessions is the primary activity card.
Schedule Results, Priority Tasks, and Attention Required support scanning and
follow-up.

There is no standalone Workspaces card. Workspace and branch appear as context
on agent-session and schedule-run rows.

### Project Chat workbench

Submitting the Overview composer creates a new thread and opens the Project
Chat workbench. Opening a recent thread uses the same workbench.

The existing global sidebar remains in place. To avoid a four-column layout,
the workbench uses two content columns:

```text
+----------------------------------------+------------------+
| Project Chat                           | Chat Threads     |
| Current thread title                   | + New Thread     |
|                                        | recent threads   |
| Conversation and live tool cards       | View all...      |
|                                        +------------------+
|                                        | Context          |
|                                        | tasks/sessions/  |
|                                        | runs/workspaces  |
+----------------------------------------+------------------+
| Message...                                      [Send]     |
+-----------------------------------------------------------+
```

The auxiliary rail is about 300px wide and contains two vertically stacked,
independently collapsible sections:

- Recent Chat Threads, limited to five rows, with New Thread and View All.
- Context for objects referenced or operated on by the current thread.

The complete thread history opens in a dialog or drawer rather than consuming
the whole rail. The entire rail can be hidden. On narrow screens it becomes one
drawer containing both sections. The current thread can also be switched from
the chat header, so hiding the rail does not remove functionality.

The workbench provides a clear Back to Overview action. Closing the workbench
does not stop active project-chat work.

## Dashboard cards

### Project Chat

- Contains the new-thread composer.
- Shows the three most recently active threads.
- Sending the first message creates a thread and transitions to the workbench.

### Recent Agent Sessions

- Shows the five to eight most recently active sessions across all workspaces.
- Displays title, status, workspace/branch, model, and last activity time.
- Opens the concrete Agent Session, not Project Chat.

### Schedule Results

- Shows the five most recent runs across all schedules, not merely the
  `last_run` of five schedules.
- Displays schedule name, status, duration, completion time, and report
  summary.
- Opens the existing full report/raw output treatment.

### Priority Tasks

- Shows at most five tasks.
- Orders `in_progress` first, then `urgent`, then `high`.
- Opens task detail and links to the complete Tasks view.

### Attention Required

- Aggregates failed/timed-out schedule runs and errored or abnormally stopped
  agent sessions.
- May repeat an item shown in another card because its purpose is action, not
  history.
- Offers contextual actions such as Open Session, View Output, or Run Again.
- Collapses to a small All Clear row when empty.

## Persistence model

Project Chat requires independent persistent storage. It must not use the
branch-scoped identity of the existing Main Chat.

### Project chat threads

```text
project_chat_threads
- id
- project_id
- user_id
- title
- created_at
- updated_at
- archived_at
```

There can be multiple threads per project. A thread has no `branch` or
`workspace_id`.

### Project chat messages

```text
project_chat_messages
- id
- thread_id
- role/type
- content
- sequence
- created_at
```

Messages are ordered append-only conversation records. Structured tool calls,
tool results, approval records, and live-operation state must remain
recoverable after a page or server restart.

### Context references

```text
project_chat_context_refs
- thread_id
- entity_type
- entity_id
- last_referenced_at
```

Supported entity types are `task`, `workspace`, `agent_session`, `schedule`,
and `schedule_run`. References are created automatically when Project Chat
queries, creates, or operates on an entity. They drive the Context rail; they
are not a user-maintained attachment list.

If an entity is later deleted, conversation history remains intact and the
Context row displays Deleted without offering a broken navigation action.

## Project activity read model

Add a project-level aggregate endpoint, conceptually:

```text
GET /api/projects/:projectId/activity
```

It returns:

- recent Project Chat threads;
- recent Agent Sessions across workspaces;
- recent Schedule Runs across schedules;
- priority Tasks;
- attention items;
- running and failed counts; and
- the next scheduled execution.

The server performs ownership checks once and executes bounded, indexed
queries. The browser must not fan out over every branch or schedule.

The frontend refetches the aggregate in response to relevant `session:*`,
`schedule:*`, and `task:*` global events. Bursts are coalesced so a single run
completion does not trigger redundant activity requests.

## Project Commander behavior

Project Chat runs a project-scoped commander. A turn follows this flow:

```text
user message
  -> load thread history and project-scoped context
  -> analyze the request
  -> query or operate on project entities
  -> choose/confirm a workspace only when concrete execution needs one
  -> surface live tool and child-operation state in the conversation
  -> record referenced entities in Context
  -> persist the response and update thread recency
```

The commander can coordinate multiple workspaces and sessions within a single
thread. If a concrete coding action has no unambiguous target workspace, it
must ask the user to select one. It must not silently guess or create a
worktree.

Schedule or agent events flow back into a thread only when that thread started,
queried, or explicitly subscribed to the operation. Project-wide events must
not be broadcast into every thread.

## V1 commander tools

V1 may:

- query project metadata, tasks, workspaces, agent sessions, schedules, and
  runs;
- read an Agent Session's status and recent output;
- create an Agent Session in an explicitly selected workspace;
- send a follow-up instruction to an Agent Session;
- create or update a Task;
- trigger an existing Schedule immediately; and
- read a Schedule Run report and raw output.

V1 may not directly:

- delete a workspace, task, schedule, or thread;
- modify schedule configuration;
- create or delete a worktree;
- stop another active Agent Session; or
- perform irreversible Git operations.

The commander may explain those actions and link to the relevant UI. Adding
them later requires explicit approval cards.

Every tool must resolve the authenticated user and verify that all supplied
entity IDs belong to the current project. Model-supplied IDs are never trusted
as authorization.

## Runtime and error behavior

- The same thread executes at most one commander turn at a time. Additional
  user messages queue, or the user can explicitly stop the active turn.
- Closing the page does not cancel an agent session or schedule run initiated
  by the thread.
- Returning to the thread restores messages, tool states, and Context.
- Long-running actions render explicit live cards rather than an indefinite
  generic loading indicator.
- Partial failure does not discard successful work. The response distinguishes
  successful and failed actions.
- A remote target failure retains the target identity and reason. The system
  never silently falls back to local execution.
- All state-changing operations are recorded in the thread for auditability.

An error card includes the object, failure type, duration when available, and a
safe next action such as View Output or Run Again.

## Components

Likely frontend boundaries are:

- `ProjectActivityView`: dashboard composition and activity loading.
- `ProjectChatCard`: Overview composer and recent thread shortcuts.
- `RecentAgentSessionsCard`.
- `ScheduleResultsCard`.
- `PriorityTasksCard`.
- `AttentionRequiredCard`.
- `ProjectChatWorkbench`: two-column chat layout.
- `ProjectChatConversation`: persistent streamed conversation.
- `ProjectChatAuxiliaryRail`: thread shortcuts and contextual references.
- `ProjectChatThreadHistory`: full searchable thread history dialog/drawer.
- Structured message cards for agent sessions, schedule runs, selections,
  errors, and approvals.

These names are boundaries, not mandatory filenames. Shared row and status
components should be extracted only when more than one surface needs them.

## Testing and acceptance criteria

### Persistence and authorization

- Creating from the Overview produces a project-scoped thread and opens it.
- A thread contains no branch or workspace ownership field.
- Messages, title, structured tool state, and Context survive page and server
  restarts.
- A user cannot read or operate on another user's thread.
- A thread in project A cannot read or operate on an entity from project B.
- Deleted referenced entities render as Deleted without breaking history.

### Coordination

- One thread can reference multiple workspaces, Agent Sessions, and Schedule
  Runs.
- Ambiguous coding execution asks the user for a workspace.
- Thread-started child operations report status only to the related thread.
- An unrelated project or thread event does not pollute the conversation.
- Remote offline, run timeout, and session-start failures yield actionable
  structured errors.

### Dashboard

- Recent Agent Sessions are ordered across branches.
- Schedule Results are ordered across schedules.
- Priority Task ordering and limits are correct.
- Attention Required aggregates failure classes and collapses when empty.
- Relevant global events refresh the dashboard with burst coalescing.

### Frontend behavior

- New, rename, archive/delete, switch, and resume thread flows work from the
  auxiliary rail and full history surface. Destructive thread actions remain
  explicit user UI actions rather than commander tools.
- The rail collapses without removing thread switching.
- The narrow layout uses a single combined Threads/Context drawer.
- Returning to Overview does not stop active work.
- The end-to-end tracer path succeeds: create thread, select a workspace when
  asked, spawn an Agent Session, receive its status, and reopen the persisted
  thread.

## Non-goals for V1

- A separate Mission entity or mission-specific workflow UI.
- Automatic worktree creation or deletion.
- Broadcasting every project event into every Project Chat thread.
- Replacing the concrete Agent Session UI with Project Chat.
- Unrestricted autonomous destructive operations.
- A fully configurable dashboard/card layout.
