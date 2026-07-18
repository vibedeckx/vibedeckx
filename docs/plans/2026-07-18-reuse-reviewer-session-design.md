# Reuse the Previous Reviewer Session

Date: 2026-07-18

## Problem

An ad-hoc review currently creates a fresh reviewer session every time. A
completed workflow run retains both `source_session_id` and
`reviewer_session_id`, and reviewer sessions retain their conversation history,
but the next review does not use that relationship.

After the source agent addresses review feedback, the default next action
should be to continue the previous reviewer session. This lets the reviewer
evaluate the new workspace state with its earlier findings still in context.
The user must also be able to choose a new reviewer session.

## Goals

- Default to the most recent reusable reviewer for the source session.
- Continue that reviewer's existing conversation with a new review turn.
- Preserve the existing option to create a reviewer with a selected agent type.
- Keep feedback capture, human approval, and delivery to the source session
  unchanged after the reviewer starts.
- Give local and remote workspaces the same behavior.
- Prevent a source or reviewer session from participating in two active review
  runs at once.

## Non-goals

- A first-class review-thread entity separate from workflow runs.
- Choosing from every historical reviewer; v1 offers the most recent reusable
  reviewer or a new session.
- Automatically falling back to a new reviewer after a reuse attempt has
  started and failed.
- Changing the human feedback approval gate.

## Chosen Approach

Use `workflow_runs` history as the source of truth. Do not add a
`last_reviewer_session_id` field to agent sessions.

For a source session, find its newest completed workflow run that has a
reviewer session. Validate that the reviewer still exists and belongs to the
same project and branch. Return that session as the reuse candidate. Cancelled,
failed, active, and reviewer-less runs are not candidates.

Every review iteration still gets a new workflow run. A reused iteration writes
the existing reviewer ID into the new run instead of creating another session.
This preserves a complete audit trail while allowing the reviewer conversation
to continue.

## User Experience

When the Review dialog opens, it requests the latest reviewer candidate for the
source session.

If the candidate is valid, the default selection is:

> Continue previous reviewer — &lt;session title&gt; · &lt;agent type&gt;

The dialog also offers:

> Create new reviewer session

Selecting a new session reveals the existing Claude Code/Codex agent selector.

If the latest historical reviewer has been deleted or cannot be reused, the
dialog automatically selects the new-session option and shows a short notice
that the previous reviewer is unavailable.

## API Shape

Add a query that returns the latest reviewer candidate for a source session.
The response distinguishes an available candidate from a known but unavailable
previous reviewer so the UI can explain its fallback.

Extend review creation with two mutually exclusive modes:

```ts
{
  projectId: string;
  branch: string | null;
  sourceSessionId: string;
  reviewFocus?: string;
  sourceTurnEndIndex?: number;
  reviewerSessionId?: string; // continue an existing reviewer
  reviewerAgentType?: AgentType; // create a new reviewer
}
```

When `reviewerSessionId` is present, `reviewerAgentType` is not accepted. When
it is absent, the current new-session behavior and default agent type remain.
The server derives and validates project and branch from stored sessions rather
than trusting client claims.

Remote front servers proxy the candidate query and creation request to the
worker. They map reviewer IDs in responses and unmap the selected reviewer ID
in requests. Session validation and execution remain worker responsibilities.

## Engine Behavior

### New reviewer

The existing path remains: reserve the source, create a read-only reviewer
session, set its title, send the initial review prompt, and store its ID on the
workflow run.

### Reused reviewer

The engine:

1. Confirms the source has a completed turn and is not running.
2. Confirms the reviewer exists, is different from the source, and belongs to
   the same project and branch.
3. Confirms neither participant belongs to another active workflow run.
4. Reserves both participants before yielding in a way that could permit a
   concurrent competing start.
5. Captures the current workspace review target.
6. Creates a new `waiting_reviewer` workflow run with both session IDs.
7. Sends a new review turn to the existing reviewer session.

The prompt tells the reviewer that the source agent has addressed the previous
feedback and asks it to inspect the latest workspace state. It asks the reviewer
to verify that prior findings were addressed, look for regressions and remaining
gaps, stay read-only, and finish with actionable feedback or an explicit
approval. An optional review focus is appended. Previous feedback is not copied
into the prompt because it already exists in the reviewer conversation.

`sendUserMessage` wakes a dormant reviewer with its preserved history. A live,
between-turn reviewer receives the new turn through its existing process.

## Completion and Feedback Flow

Both creation modes use the existing state machine:

```text
waiting_reviewer
  -> waiting_feedback
  -> sending_feedback
  -> completed
```

The workflow engine associates the reviewer's new `session:taskCompleted` event
with the new run. It extracts the final assistant output before that turn's
`turn_end` boundary and stores it in `feedback_snapshot`. The existing UI lets
the user inspect or edit it. Approval sends the feedback as a user message to
the run's `source_session_id`.

## Concurrency and Failure Handling

- Both source and reused reviewer are exclusive active-run participants.
- Concurrent attempts to claim the same source or reviewer allow exactly one
  run to start.
- Server-side validation is repeated during creation; the dialog's candidate
  response is advisory and may become stale.
- If the reused reviewer disappears or becomes busy before creation, creation
  fails with a specific error so the dialog can refresh and let the user choose
  a new session.
- If delivery of the re-review prompt fails, the new run becomes `failed` and
  both participant reservations are released.
- The engine does not silently create a new reviewer after a failed reuse. That
  would discard the context the user explicitly selected.
- Existing crash recovery remains. Active run participant mappings are rebuilt
  from stored workflow runs. A restart during `waiting_reviewer` reports that
  the completion event may have been missed instead of resending the prompt.

## Persistence

No schema change is required. Add a repository query that searches completed
runs for a source session in newest-first order. The query may return successive
historical rows until the service finds an existing, compatible reviewer, or it
may return only the latest row and classify it as unavailable. The externally
visible rule is that the most recent successfully completed review determines
the default; the system does not silently skip that reviewer to select an older
one.

## Testing

Backend repository and route tests cover:

- selection of the newest completed run with a reviewer;
- exclusion of cancelled, failed, active, and reviewer-less runs;
- classification of deleted, cross-project, and cross-branch reviewers as
  unavailable;
- request validation for mutually exclusive reviewer selection modes;
- remote ID mapping and proxy behavior.

Workflow engine tests cover:

- reuse does not call `createNewSession`;
- the existing reviewer receives the re-review prompt;
- dormant reviewers are supported through `sendUserMessage`;
- source/reviewer compatibility validation;
- rejection when either participant is in an active run;
- exactly one winner when concurrent starts claim the same reviewer;
- failed prompt delivery marks the run failed and releases both participants;
- completion snapshots only the reused reviewer's new turn output;
- the existing approval path sends feedback to the source.

Frontend tests cover:

- valid previous reviewer is selected by default;
- switching to a new reviewer reveals the agent selector;
- unavailable previous reviewer falls back to a new session with an explanation;
- the selected mode produces the correct creation payload.

