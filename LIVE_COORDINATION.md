# Live coordination implementation status

Current source/release information is in [CHANGELOG.md](CHANGELOG.md). Version 0.6.1 added goal-scoped delivery and safe reconnect behavior; 0.6.2 adds the Windows HTTPS trust-chain fix. The dated sections below retain earlier implementation evidence, not the current acceptance result.

## Approved automation 0.6.0

Team mode now includes opt-in isolated worktrees, one automatic helper per PC/run, developer-approved setup/tests, and local Git integration to a dedicated branch. See [GETTING_STARTED.md](GETTING_STARTED.md) for the current workflow and [TEAM_COORDINATION.md](TEAM_COORDINATION.md) for execution and recovery boundaries. The manual-only sections below are historical releases, not the current automatic-mode feature list.

## Automatic team mode 0.5.0

`relay-workspace team` adds shared goals, automatic task planning and assignment, independent peer review, cross-checkout artifacts, and guarded ownership. See [TEAM_COORDINATION.md](TEAM_COORDINATION.md) for the current architecture and limits. The sections below preserve the earlier `live` mode and its test history; existing live sessions are not automatically enrolled into team mode.

## Managed working-session release 0.4.0

The user approved launching **new** managed Codex/Claude sessions while leaving all existing conversations and settings untouched. `relay-workspace live` now implements that workflow. See README for the short startup instructions.

Verification on Windows: full regression suite 115 tests passed, expanded managed-runtime suite 9 tests passed, and 32 browser checks passed. Native Codex 0.154.0 and Claude Code 2.1.270 each passed a fresh-session guarded write, idle wakeup, explicit acknowledgement and second guarded write. A combined native test used two distinct workspace identities and separate checkouts: both actual providers exchanged peer reviews and wrote their disjoint files. Evidence: `.relay/managed-codex-verification.json`, `.relay/managed-claude-verification.json`, `.relay/managed-pair-verification.json`, `.relay/companion-qa/live-working-mobile.png`. These tests created new QA conversations only. **This is not physical Windows/Mac acceptance.**

## Runtime and protection boundary

- The CLI confirms the Git root per start, reuses matching-origin saved identity, asks for the developer's task and explicit sharing/write consent. A Git-root-commit hash catches mismatched repository histories. No global working root or old connection is rewritten.
- Codex uses a new owned App Server thread, read-only native sandbox, disabled shell/apps/other MCPs/hooks and guarded dynamic tools. Active-turn messages use steering. Claude uses a new UUID, restricted streaming mode, disabled built-in tools and only the run-scoped Relay MCP. It processes automatic messages between turns. No channel-preview bypass is used.
- A local heartbeat/controller check and authenticated hub gate run before each guarded file replacement. Plans/reviews, declared scope, incoming acknowledgements, Git base, file hash and path restrictions must pass. Symlinks, reparse points, hard-linked files, nested repositories, secrets and agent settings are excluded. Original bytes are backed up in the private run directory.
- This is a limited coding toolset: UTF-8 read/list/create/replace only. No shell execution, deletion, automatic tests, merging, settings writes, external integrations or subagents. External editors/processes are not intercepted, and a write already past its gate is not retroactively cancelled. This is not an adversarial local-user security boundary.
- `/pause` closes the local guard before interrupting the owned provider. `/resume` continues only that newly created managed conversation. `/quit` stops it without releasing unfinished reservations. A stopped run can be reconciled with human-only `live-release --run ...`; confirmation and a note are required and no model is launched.
- Automatic batches are capped at 12/hour/controller, tool calls at 60/turn, and active turns at five minutes. These are not dollar/token caps. Network or provider failure pauses live work; failed delivery is never treated as an acknowledgement or silently retried as a new coding turn.
- Ask live peers questions using work messages on their plans; these wake the working agent. Existing `relay_clarify` explanation-worker connections remain read-only. A new live feature does not automatically gain an independent explanation worker.
- Shared visible replies, task excerpts, work messages and receipts appear in Team workspace. Redaction is best-effort and hidden reasoning is excluded. The live terminal must stay open; closing the browser companion is separate from stopping a live controller.

## Implemented

- Explicit per-session controller enrollment with a repository identity key. A live controller cannot steal another current controller or retarget its session; the caller must derive the key from the confirmed checkout. A matching caller-supplied key is not independent repository verification.
- Durable per-recipient delivery records for work plans, reviews, messages and state changes. Pending records survive restarts and are not bounded by the 200-message UI history window.
- Separate delivery and acknowledgement. `relay_live_inbox` records tool delivery; `relay_live_ack` records the working agent's stated disposition. Neither substitutes for revision-bound peer agreement.
- Work checks for enrolled sessions stop on unread/unacknowledged messages, paused/offline/revoked participants and live peers without work plans. Polling renews the controller heartbeat; it does not resume a paused controller.
- `work-pause` retains reservations. Replanning a paused plan retains its previous reserved paths/interfaces, increments its revision and requires fresh peer reviews. Release remains explicit, including after disconnect or controller exit.

Existing connectors remain advisory and existing explanation jobs remain read-only. No existing source conversation or agent setting was changed by these implementations or QA runs. New MCP tools require an explicitly configured live controller and fail closed for ordinary connectors.

## Remaining acceptance

Von must update Relay and test on his Mac. Both developers must confirm the same shared repository and exercise task delivery, disjoint edits, overlap blocking, paused/offline participants, reconnect and actual sleep/wake. The private hub still runs on the laptop and must stay awake; no cloud deployment was made. Arbitrary shell/test execution and automatic merging are intentionally outside this first managed version.

## Integration evidence checked 2026-09-13

- Local CLI versions: Codex 0.154.0 and Claude Code 2.1.270. Native fresh-session QA subsequently passed as described above.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) provides owned thread/turn lifecycle, active-turn steering and interrupts. A separate explanation app-server is not evidence it controls an existing native coding UI.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks) can intercept supported local tool paths; the documentation explicitly describes coverage exceptions. They are not a complete enforcement boundary, nor an idle-session wakeup mechanism.
- [Claude Code channels](https://code.claude.com/docs/en/channels) support opted-in push delivery but remain subject to preview availability and allowlists. Do not bypass organizational controls or silently add a development-channel flag.
- [Claude hooks](https://code.claude.com/docs/en/hooks) provide tool checkpoints; Stop hooks have continuation limits. Polling in Stop is not equivalent to an indefinitely available idle working agent.

The safe target is opt-in managed sessions with explicit acknowledgement and guarded edit boundaries. Native provider permissions must remain in place; peer messages are untrusted collaboration data, not new authority to execute arbitrary commands or expand the user's task.
