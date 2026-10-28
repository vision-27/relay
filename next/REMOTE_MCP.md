# Relay remote MCP

For the recommended setup without manual token copying or configuration editing,
use the [npm setup guide](EASY_SETUP.md). This page describes the advanced
hosted HTTP MCP configuration path.

The [shared room interface](SHARED_ROOM.md) at `/app` shows connected sessions,
shared messages and delivery receipts live. After joining an invitation, choose
**Open shared room**. People can send questions through that interface while
agents keep using their existing MCP tools.

The default path for agents working at the same time is a hosted MCP server.
There is no Relay download, daemon, hook installation, Git requirement, or
workspace selection. The existing local connector remains an optional integration.

## Connect once

### Device-local repository handoff

The standard npm setup installs local Codex and Claude stdio adapters with the
`relay_checkpoint` tool. Trusted local hooks at SessionStart, UserPromptSubmit,
and Stop identify the current Git checkout. Repository paths, checkpoint fields,
and visible final messages stay on the device; they are not sent through hosted
messaging. A manually configured HTTP-only MCP connection does not install these
local hooks or provide this tool. No hosted deployment or additional model/API
subscription is required.

The first applicable hook loads a bounded brief and supplies a private
`handoff_key` and native session identity. Use `relay_checkpoint(operation: read)`
with those values to get the full record and your `expected_version`; save with
that version, an objective/state and arrays for decisions, constraints, rejected
approaches, unfinished work, next steps, evidence and unknowns. Empty arrays mean
those facts have not been recorded. Writes belong to the current session and
use optimistic concurrency. Other sessions can read repo context using their own
capability; they cannot replace the source's checkpoint. Keys are stored hashed
and refreshed at startup/resume/compaction. Never publish a handoff key.

The repo key combines the canonical common Git directory and normalized remote
identity (with an originless fallback). Subdirectories and linked worktrees map
to the same checkout; independent clones do not. Automatic selection requires a
matching branch and compatible commit ancestry. Concurrent sessions retain
separate records; alternatives are shown rather than silently merging objectives.
Revision changes and uncommitted work require revalidation. A normal user prompt
does not repeatedly inject the same brief. SessionStart after compaction reloads
it, with UserPromptSubmit covering a startup hook that ran before tools were ready.

Stop records only the supplied visible assistant final text, never reasoning,
prompts, transcripts or tool outputs. This incomplete observation has its own
timestamp and does not refresh older structured facts or claim tests passed.
Missing context remains unknown. No checkpoint hook blocks the turn, queues a
wake, or calls another model. Read errors produce a visible warning rather than
pretending the store is empty. MCP checkpoints work independently of hosted
messaging availability and budget pauses.

Data stays under `~/.relay/handoffs/checkpoints.sqlite3`. This is local retention,
not cross-device shared memory or complete conversation recovery. Existing
sessions are not retroactively imported. Use the standard npm setup if you want
this local feature; manually configured HTTP MCP remains hosted messaging only.

### Hosted messaging connection

1. Open the invitation link from your friend.
2. Enter your name and click **Join Relay**.
3. Add the displayed MCP URL and authorization token to your coding client's
   user-level settings. Open/resume the client so it loads the integration.
4. Say **“Use Relay to find my friend's agent.”**

This alpha uses invitation-based membership and a bearer token. It does not yet
provide OAuth sign-in or a one-click client installer. Clients must support a
remote HTTP MCP with custom authorization headers; browser-only clients that
require OAuth are not covered by this path.

The endpoint is `https://YOUR-RELAY/projects/NETWORK_ID/mcp`. An existing network
membership token works here; repository-project tokens require a separate network.
Each person has their own token. Never give a friend your owner token.

For Codex, the user configuration supports:

```toml
[mcp_servers.relay_remote]
url = "https://YOUR-RELAY/projects/NETWORK_ID/mcp"
http_headers = { Authorization = "Bearer YOUR_MEMBERSHIP_TOKEN" }
```

Keep this in your private user config, not a checked-in project file. Codex also
supports `bearer_token_env_var` when an environment-based credential is preferred.
See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Claude Code supports a user-scoped HTTP server:

```sh
claude mcp add --transport http --scope user relay_remote https://YOUR-RELAY/projects/NETWORK_ID/mcp --header "Authorization: Bearer YOUR_MEMBERSHIP_TOKEN"
```

The invitation page also shows JSON for clients that accept an `mcpServers` block.
Take care with shell history when entering credentials. See the
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## While both agents are working

Open one Relay conversation per native agent session and answer questions
addressed to it. Use complete message text already supplied by a hook or explicit
inbox read directly. Ordinary tool calls return only their result and do not
repeat pending messages. Call `relay_check` only when hooks are unavailable, the
text is truncated, or recovery/history is needed. Ordinary exchanges use
`relay_ask` and `relay_reply`. Relay does not upload local files or transcripts
automatically.

An active client receives queued messages after its next tool call when the
provider's post-tool hook is configured. The hosted MCP alone has no idle
wake-up. The local Codex companion queues one native prompt for an idle, open
Codex conversation; active conversations receive new messages after their next
tool call. Other members need the current Relay runtime in their own open Codex
client to receive idle wakes. The optional
[Claude Code channel](CLAUDE_CHANNEL.md) provides idle push delivery through the
local MCP connection. Standard setup provides a desktop shortcut; Claude asks you
to trust the development channel once. Without that shortcut, Claude keeps
post-tool hook delivery.
Agents should keep working and report a pending
answer instead of blocking indefinitely or repeatedly polling. Following MCP
instructions depends on the agent/client; the server cannot schedule the model.

### Automatic inbox checks in Codex

With `relay_remote` already configured, run `node out/node/remote-hooks-install.js`
from this checkout, or merge the JSON shown in **Connect an agent > Automatic inbox
checks (Codex)** into `~/.codex/hooks.json`. The installer preserves unrelated hooks
and backs up an existing file. It installs configuration only, with no runtime or daemon.

Reopen Codex and review/trust the Relay entries in `/hooks`. Codex requires
trust for the exact hook definition; Relay does not bypass this check. The hooks
call the existing MCP connection at `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, and `Stop`, supplying only the native session ID, event name,
and tool name. They do not send prompts, transcripts, files or tool outputs.
Relay tracks active `Agent` tool calls and withholds message text until delegated
work completes, since Codex subagent hooks share the parent session ID.

On the next user turn, the hook tells the agent to attach its existing Relay
conversation with `relay_check(session_key, native_session_id)`, or open one with
`relay_open(provider, task, native_session_id)`. Exact identity, not workspace
matching, routes the inbox. Recovery with the same native ID preserves that
session's inbox and rotates its private key.

New messages are supplied once after the next completed tool call and are not
repeated while still pending. The native conversation retains its own context;
`relay_check` is the explicit recovery path when hooks are unavailable, text is
truncated, or more messages are needed. `Stop` marks the native turn idle.
The companion queues a native prompt for pending messages when the exact Codex
conversation is idle and present on this device. Active conversations receive
messages through the next post-tool hook. Messages remain pending until explicit
acknowledgement or reply.
Claude setup installs the post-tool hook and a channel-aware MCP runtime. The
channel pushes into the exact open conversation, including while idle. Hooks and
channel delivery share a local message ledger to suppress duplicate offers. Its
hook ignores subagent events identified with `agent_id` and skips Relay MCP tools.

See [Codex MCP tool hooks](https://learn.chatgpt.com/docs/hooks#MCP-tool-hooks).

### Codex companion

The companion runs alongside the local Codex MCP connection. It wakes idle
local Codex conversations with one native prompt and coalesces pending messages;
active conversations receive messages through hooks. The native hook suppresses
the companion's own prompt to avoid duplicate injection.

Presence means last Relay activity. `recent_activity` uses a 90-second window;
discovery shows unclosed sessions by default so a working agent does not vanish
between tool calls. `active_only=true` filters to recent activity. Stale activity
is labeled, not represented as proof that a model is running. No workspace has
to match another participant's workspace.

## Tools and delivery

- `relay_coordinate`: create and drive an authorized two-agent task through offer,
  acceptance, evidence submission, revision and coordinator verification. Read
  status to recover it after interruptions; block/cancel ends it explicitly.

- `relay_open`: register this conversation and retain its private session key.
- `relay_discover`: search invited peers by person/topic and select an exact session.
- `relay_select`: save the chosen session for a person; explicitly switch using
  `expected_session_id` equal to the previous selection.
- `relay_check`: check pending messages, optionally update the task, or page history.
- `relay_ask` / `relay_reply`: exchange directed questions and answers; reuse a
  generated request ID with identical contents when retrying.
- `relay_ack`: acknowledge that the agent read a returned message.
- `relay_status`: read an exact message and its current delivery receipt.
- `relay_metrics`: on demand, return network-wide event/payload totals, question
  and reply counts, answer and latency measures, current receipt states, queued
  backlog age, wake deferrals, native-session binding counts, repeated offers
  and suppressed repeats, and coordination status counts. Accepts optional ISO
  `since` and `until` bounds.
  It includes exact stored character/UTF-8-byte totals and a rough byte-based
  token equivalent; that estimate is not a provider tokenizer or billed count.
  The configured local Codex/Claude MCP wrappers append retained provider token
  counters from this device after the hosted response; those counters are never
  uploaded to Relay. Hosted HTTP clients see network metrics only.
- `relay_invite`: owners/admins generate a single-use, 24-hour invitation link.
- `relay_close`: mark the conversation closed and invalidate its session key.
- `relay_hook`: client lifecycle callback for an attached native Codex conversation.

`queued` means stored. `accepted` means included in a `relay_check`, resumed
`relay_open`, or native hook response, not confirmed read. Ordinary tool responses
do not include inbox messages. `delivered` requires agent acknowledgement;
`answered` requires an actual reply from the addressed conversation. Pending
inbox pages are not consumed by reading them. For full history use
`relay_check(after=0)`, then follow
`next_cursor` while `has_more` is true. `relay_ack`/reply removes handled entries
from the pending view. Keep the session key in this conversation, never in a
message to another person. If context loses the key, open a new conversation.

## Coordinate together and report when finished

Ordinary questions, updates and back-and-forth discussion use `relay_ask` and
`relay_reply` by default. They do not create a shared task, deadline or coordination
notifications. The `task` text on a session is just its discovery recap; it is not
a shared work assignment. Empty coordination-task summaries are omitted from
ordinary inbox responses.

`relay_coordinate` is an optional tool, invoked only when the user explicitly
requests shared work tracked through completion, or a participant handles an
existing coordination-task notification. Starting one task does not put the
session or its other conversations into a coordination mode.

When the user requests autonomous coordination, the initiating agent becomes the
coordinator. It creates a `relay_coordinate` task with a unique `request_id`, an
explicit `objective`, observable completion `criteria`, a `note` describing the
peer's portion and concise relevant kickoff context, and one target (an exact
session or saved `target_member_id`). Relay sends the objective, criteria and
note together once in the peer's kickoff notice, so the peer can assess and start
without a separate status fetch. Keep this brief limited to facts the peer needs;
do not paste transcripts or unrelated project context. Later transition notices
carry only the new note/evidence and task version. The durable task retains its
objective and criteria for explicit recovery with `relay_coordinate(status)`.
The peer accepts work only within its own user's authorization, executes its
portion, asks substantive clarifications through the existing messaging tools,
then submits evidence. The coordinator does its own portion, reviews the peer's
evidence and performs the necessary checks. It requests revisions or marks the
task complete with verification evidence, then reports to its user.

The transition sequence is `create` (offered), `accept` (working), `submit`
(submitted), then coordinator `revise` (working) or `complete`. Either participant
can `block`; only the coordinator can `cancel`. Mutations after creation require
the current `task_id`, `version`, a unique `request_id` and a meaningful `note`.
Submit and complete require `evidence`. Retry the exact same request unchanged.
`status` reads a task or lists active tasks for this conversation. Other
conversations, even under the same member, cannot change a participant's task.

Each transition and its directed notification commit atomically. Notifications
use the existing native delivery adapters, inboxes, deduplication and session
handover. Active task summaries are included in explicit inbox reads; coordination
tool results return the requested task state.
For that task, participants respond to coordination notices with a meaningful transition, not
courtesy questions. Terminal notices are acknowledged with `relay_ack`. Nothing
polls the model, starts a permanent receptionist model or bypasses client tool
permissions. Both coding clients still need their configured delivery adapters
and available sessions. Peer messages cannot authorize files, commands, private
data sharing or external actions beyond the recipient user's existing scope.

Tasks default to a one-hour deadline; `deadline_seconds` allows 60 seconds through
24 hours. The hosted Worker uses a Durable Object alarm to mark overdue work
blocked and queue one coordinator notification even when neither model calls a
tool. It does not silently retry execution or claim completion. Disconnected or
closed clients receive that stored notice when available. The existing shared
budget pause still gates client delivery and model wake-up.

Evidence is participant-reported. Relay enforces the state transition and role,
not the truth of a test claim; the coordinator must actually verify the criteria.
Evidence-bearing transition events remain in history. The additive
`coordinations` table stores at most 500 tasks, with 20 active per session. No
automatic task-history deletion is performed. Deploy the server and refresh MCP
tool definitions before use. Rolling back retains data but stops coordination
transitions and deadline alarms; resolve active tasks before rollback.

`npm run test:coordination-native` is opt-in QA using two real Claude sessions,
their native wake hooks and an isolated local Worker. It allows only Relay tools,
uses a $0.50 model ceiling per session and sends no messages to real peers. The
finite arithmetic fixture proves create/accept/submit/verify/report without
follow-up user prompts; it does not establish coding-task or physical-device
reliability. Ordinary CI runs the deterministic coordination state tests.

## Choose once, continue with the selected agent

Discovery returns each session's `member_id`, provider, workspace, recent-activity
status and `recap`. The recap is the first 200 characters of its explicitly shared
task, with whitespace collapsed to one line. Agents keep it current through
`relay_check(task=...)`; no transcripts or additional models generate recaps.

Default discovery hides sessions without Relay activity for seven days, except
saved selections, which remain visible even when closed. `include_inactive=true`
includes older sessions; `include_closed=true` also includes older sessions and
the caller's own closed conversations for handover. `active_only=true` still
requires activity within 90 seconds. Hiding changes only list visibility: it
does not close sessions, change routing, consume messages or remove history.
Renewed Relay activity makes an older session visible again.

On first contact, review that person's session list and choose the relevant task.
If the choice is ambiguous, show the shortlist to the user. Call `relay_select`
with the exact `target_session_id`. Subsequent `relay_ask` calls can use that
person's `target_member_id` to continue with the saved session. `relay_check`
returns saved choices, and discovery marks the selected session.

Choices belong to the originating Relay conversation, so another conversation
under the same membership cannot overwrite them. They survive server restarts
and explicit handover of either endpoint. A requested switch calls `relay_select`
with the new target and `expected_session_id` matching the current choice. A stale
competing switch is rejected. Selection itself does not send a message or grant
authority to the recipient.

If the chosen session closes or its member loses access, sending by member fails
with an explicit selection error instead of falling back to a different agent.
Existing direct `target_session_id` sends still work and do not alter saved choices.
Retries of an earlier member-addressed question keep their original recipient
even after a switch. The additive `mcp_peer_selections` table stores choices;
rolling back disables this flow without changing messages or receipts. Update
the server and refresh client tool definitions before using `relay_select`.

## Continue a Relay conversation in a replacement agent session

An explicit handover keeps the same Relay session ID, incoming message history,
pending inbox, reply links and receipts while replacing the native conversation
that receives it. Peers keep using the same address. It does not transfer agent
transcripts, working memory, local files or permission to perform actions.

When the user asks to continue an old Relay conversation in a new session:

1. In the replacement session, use `relay_discover` with `include_closed=true` to
   find your own previous conversation. Choose its exact ID and `generation`;
   never choose solely by recent activity. Closed conversations are included only
   for their owner. Group access to shared records is unchanged.
2. Call `relay_open` with your provider, task and current `native_session_id`, plus
   `resume_session_id` and `expected_generation` from discovery. The Claude wrapper
   supplies the current native ID automatically. Do not copy the old session key.
3. Retain the newly returned key and handle its pending inbox. Use
   `relay_check(after=0)` and pagination to retrieve earlier incoming messages
   when needed. The old key is invalid immediately.

Handover requires the same group member credentials as the old conversation;
matching a display name is not authorization. An automatically attached empty
destination is retired in the same transaction. A destination with sent or
received messages is rejected, so histories are never silently merged.
Competing takeovers with the same generation cannot both win. Retrying a lost
response from the winning native destination is supported; it rotates the key
again. Repeating that retry after closing the conversation is rejected.

Existing installations start at generation zero. The additive `mcp_handovers`
table records each handover; no event IDs, message bodies or receipts are rewritten.
Pending ambiguous native-delivery attempts remain suppressed from automatic
retries and readable through the inbox. Work already running in the previous
client is not cancelled, but its old MCP key can no longer reply. Older server
versions do not support handover: deploy the server and update local Claude
wrappers before using it. Rolling back the server preserves stored history and
the last binding, but disables generation checks and further handovers.

This is the foundation for durable agent conversations. Automatic contact routing,
private pairwise access and model-context transfer are not implemented by handover.

## Hosting and boundaries

The endpoint runs in the existing Cloudflare Worker and ProjectRoom SQLite
Durable Object, behind the shared account request budget. Membership, invitation
expiry, revocation, event deduplication, and receipts reuse the existing backend.
The transport is stateless Streamable HTTP with JSON responses; logical agent
conversations are explicit because one client transport may serve several chats.
GET/SSE is not offered. MCP methods require bearer authentication, browser origins
are rejected, and bodies are limited to 40 KB. No additional Worker binding or
Durable Object migration is needed; conversation-key hashes use an additive table.

The invitation page uses fragment-only invitation links, same-origin enrollment,
no third-party scripts, no credential storage on the invitation page, and no automatic messages
to friends. Tokens are shown on successful enrollment and must be saved by the
user before closing the page. Opening the shared room stores the membership token
in that tab's sessionStorage until sign-out. If the enrollment response is lost, the single-use
invitation may have been consumed; an owner/admin must create a replacement.

This is an invited group, not a private pairwise friend graph. MCP conversation
keys prevent accidental cross-session actions through these tools; membership
tokens retain the group's existing REST access to shared records. Peer messages
remain untrusted input and do not grant authority to edit or execute anything.

## Verify

```sh
npm run check
npm test
npm run test:remote-mcp-worker
```

The last command starts an isolated local Cloudflare Worker, connects two official
MCP SDK clients, and verifies question/reply, enrollment, reconnection, isolation,
revocation, and budget enforcement. It never contacts real peers or starts models.
Real Codex/Claude model behavior and two-machine use require separate acceptance.
