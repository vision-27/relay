# Relay advanced reference

Start with [README.md](README.md) and [GETTING_STARTED.md](GETTING_STARTED.md). This reference covers both managed team mode and the separate advisory conversation-sharing connector; their permissions are different.

## Start here: automatic team coding

See [release notes](CHANGELOG.md) for the current source and deployed versions, and [POLISH_QA.md](POLISH_QA.md) for verification and remaining Mac acceptance checks. Another PC must upgrade and launch fresh sessions to load changes.

Run `relay-workspace team` on each computer. From a Windows source checkout, replacing the example repository and hub:

```powershell
python -m relay team --repo C:/projects/YOUR_REPOSITORY --url https://YOUR_TEAM_HUB
```

Confirm the repository, choose Codex or Claude, and create or join the same shared goal. Give Relay the outcome in normal language. There is **no existing-session picker and no manual worker assignment**. New agents opt into that goal; existing conversations and settings stay untouched. A teammate can join directly with `relay-workspace team --goal GOAL_ID --url YOUR_HUB`.

Relay elects a planner, requires independent review of the task graph, assigns disjoint ready tasks automatically, exchanges task questions, and routes submitted file artifacts to the other developer's agent for review. Requested corrections return to their original worker, with at most three attempts. The dashboard shows shared goals, owners, progress and verification state. Team tools return goal-scoped context instead of the full workspace history.

Keep the team terminal open. Normal messages add requirements to the shared goal. New requirements trigger planning/review without stealing current ownership. `/pause`, `/resume`, `/status` and `/quit` control this new worker. The goal owner can `/export TASK_ID` to inspect a private bundle of submitted files and hashes, integrate and test those changes, then `/accept TASK_ID` followed by `/confirm TASK_ID <verification note>`. Acceptance checks current local file hashes. `/recover TASK_ID` plus a confirmation note reconciles a stopped worker before reassignment; it does not merge, revert or delete files.

At startup, opt into **automatic mode**. Relay creates isolated worktrees from committed HEAD, can start **one helper per PC per run**, and shares the goal context with it. The goal owner chooses a test command and, optionally, a dependency-setup command. Once explicitly approved, the controller runs those commands against reviewed candidate changes and merges passing results into a dedicated local `relay/goal-...` branch. Up to four implementation tasks can run per goal. Dependency artifacts sync automatically into opted-in worker checkouts.

Failed tests return corrections to the same worker for at most three attempts. Conflicts, setup failures, timeouts and unexpected file/history changes stop integration and preserve the candidate. `/status` explains the problem; `/retry TASK_ID` explicitly retries a stopped integration. No task is complete until the tested tree is merged and the matching receipt is accepted by the hub.

**Important:** test/setup commands execute repository code with your OS permissions, not in a security sandbox. Approve only trusted commands and code. Your original working folder, uncommitted changes and existing conversations are untouched. No code is pushed, and `main`/your current branch is never automatically merged. The result is the dedicated local integration branch printed at startup. Browser sharing alone does not activate automatic coding.

Use `--manual` to skip automation. Keep the team terminals open. `/help` explains controls. Model turns remain capped at 12 automatic batches/hour per controller, five minutes/turn; artifacts at 120 KB; each approved setup/test command at 120 seconds. Helpers have the same restrictions and cannot recursively spawn helpers. An app/controller crash does not silently repeat an uncertain merge or test run; interrupted integration requires reconciliation (see the guide).

For the full two-PC walkthrough, commands and recovery steps, read [GETTING_STARTED.md](GETTING_STARTED.md).

See [TEAM_COORDINATION.md](TEAM_COORDINATION.md) for lifecycle, permissions and recovery boundaries.

## New live working sessions (0.4.0)

Run `relay-workspace live` (Homebrew) or `python F:\cowork\relay\launch.py live` (this Windows source installation). Each launch confirms the current Git root, lets you choose another folder, reuses your saved workspace identity for its exact URL, asks for your task and requests explicit consent. It creates a **new** Codex/Claude conversation; no existing conversation is resumed, retargeted or reconfigured. There is no separate MCP installation for these managed sessions.

Both developers choose the same shared project and checkouts of the same Git repository. Optional flags: `--repo PATH`, `--url URL`, `--project NAME_OR_ID`, `--agent codex|claude`. Repository identity uses Git root commits, not folder names; shallow/unrelated histories may need reconciliation before joining.

Keep this terminal open. Type task messages normally; `/pause` blocks managed tools and interrupts the owned agent, `/resume` continues that same newly created managed conversation, `/status` reports connectivity, `/quit` stops it. Peer events wake idle agents automatically. Codex also accepts active-turn steering; Claude receives queued events between turns. New messages block the next guarded write until acknowledged. Normal shared context/explanation sessions remain separate.

This first version provides repository file listing, UTF-8 reads and guarded create/replace tools. Writes require an active controller, a started/reviewed plan, declared scope, current Git base and matching file hash. Previous bytes are backed up privately. It does **not** offer shell commands, deletion, agent/settings edits, automatic Git merging or general external tools. Run tests in your normal terminal. Native Codex tools remain read-only; Claude uses restricted mode and only the managed Relay MCP. These controls do not intercept external editors or other local processes.

Plans, visible replies and activity appear in Team workspace; known secrets are redacted but detection is not guaranteed. Hidden reasoning is not shared. Automatic delivery is capped at 12 batches per rolling hour per controller; tool calls are capped per turn and turns time out after five minutes. These limits are not a dollar/token spending guarantee.

Quitting or disconnecting never releases unfinished reservations. Reconcile changes before asking the agent to release its plan. For an already stopped managed run, `relay-workspace live-release --run PATH_TO_CONNECTION_JSON` asks for root confirmation, a reconciliation note and explicit approval; it releases only that run's reservation and does not touch code or conversations.

Requires an updated 0.4.0 hub, Codex CLI 0.154.0+ or Claude Code 2.1.259+ (native tests used 2.1.270), existing provider sign-in, and connectivity to the hub. No additional Python packages are needed. The private laptop hub still needs to stay awake. See [LIVE_COORDINATION.md](LIVE_COORDINATION.md) for verification and limits.

## Confirm the repository on every CLI start (0.3.1)

`relay-workspace start` always confirms the actual Git checkout root, including when resuming a saved connection. Starting in a subfolder shows its repository root. Answer **n** to enter another folder, or **q** to cancel before any hub request or sharing change. Optional `--repo /path/to/project` suggests a root for that invocation only; it does not bypass confirmation or set a global default.

Relay uses the confirmed root for the session and only offers saved conversations from that checkout. Switching roots creates/selects a separate connection; previous connections and ownership are not retargeted. New CLI credentials and preferences live in private per-checkout application data, not in the coding repository. Existing legacy `.relay` connections remain readable without moving or overwriting them. A launcher's workspace URL may be reused, but its project selection is not silently carried to another checkout.

The parent terminal and already-running coding agents keep their own working directories. The CLI prints an exact folder-change command; start or reconnect the coding conversation in that root. This confirmation is for explicit `start` calls, not background recovery, MCP stdio, or login startup—those never prompt or open terminals. It does not enforce every direct launch of the Codex/Claude executables.

## Two-person reliability release (0.3.0)

The local app now runs under a quiet supervisor: a crashed app or sharing worker is retried automatically. Quit Relay is intentional and stops app recovery until an explicit launch or the next enabled login startup. Pause remains a server-side sharing choice and is preserved through restarts. Recovery never reconnects an unapproved conversation.

In Settings, **Start Relay when I sign in** explicitly enables per-user login startup. It does not install a boot-time system service or keep a sleeping PC reachable. Windows uses a dedicated current-user Run entry, macOS a user LaunchAgent, and Linux a desktop autostart entry. Native Mac/Linux login execution remains an acceptance-test item; generated registrations are covered by tests.

**Team workspace → Check team connection** compares exact source build hashes for the hub, sharing workers and coding-agent connectors. It requires two distinct developers, active sharing, a live coding-agent link, prior successful tool use and an initial generated context summary. Unknown/older builds require an update; registration or a worker heartbeat alone is not successful agent-tool use. This check makes no model calls and does not certify matching repositories or a successful physical two-PC round trip.

Upgrade a Homebrew installation with one line, then Quit/reopen Relay and reconnect its MCP tools in the coding client:

```sh
brew update && brew upgrade relay/workspace/relay-workspace
```

For a workspace host, the optional advanced command below enables quiet login startup and supervision for an **existing** hub on loopback port 7331. Replace the path with that hub's data directory; never use a teammate's client directory. Disable login startup by replacing `--enable` with `--disable` (this does not stop an already-running hub).

```sh
python -m relay startup --kind hub --data /absolute/path/to/existing/hub --enable
```

The host must stay awake and signed in, with its private network connected. An always-on deployment is still separate. Crash recovery does not forcibly kill hung processes, and supervisor-process failure itself requires reopening Relay or signing in again. See [the two-person acceptance checklist](RELIABILITY_ACCEPTANCE.md) before treating the setup as validated for daily work.

Relay connects the understanding inside your team's **Codex and Claude Code sessions**. Developers keep coding on their own PCs. A local watcher shares selected session activity, maintains feature context after completed turns, and answers clarification requests through separate explanation forks.

The browser has two connected fronts: **continuously updated shared context and activity**, and **agent-to-agent clarification conversations**. You connect a source session once; writing handoff documents is not the normal workflow.

## Run the workspace

### Work coordination preview (source version)

Relay now exposes a cooperative pre-edit protocol through the connected agent's MCP tools. This is **advisory, not an installed edit gate**. No hooks, coding-client permission changes, new coding sessions, worktrees, pushes, or merges are installed or performed by this feature.

The agent reads `relay_project`, publishes `relay_work_plan` with affected repository-relative paths, shared interface names and a concise plan, then exchanges `relay_work_review` and `relay_work_message` with participating peers. `relay_work_update` supports `start`, `check`, `finish`, and `release`. The connector attaches the local Git HEAD; the server atomically grants a reservation only when the current peer reviews agree and no working or integration-pending reservation overlaps. Different scopes can run concurrently. Declared shared interfaces are exclusive, conservatively serializing changes to the same contract even in different files.

Review is tied to both plan revisions. Replanning invalidates it; a new participant requires another check. Agents must call `check` before each edit batch and stop on blockers/network errors. A heartbeat older than 120 seconds is labelled stale, but the reservation is **not** freed. `finish` retains it while integration is pending; `release` requires an attributed reconciliation/cancellation note. Results and test evidence are agent-reported, not independently verified. Revoking a member does not free unfinished work; recovery of abandoned reservations is not automated in this preview.

The existing Team workspace / Shared context view shows a compact Working together panel when plans exist. Discussions are collapsed by default; no new developer onboarding forms are required.

Limits of this advisory connector: only sessions that publish plans participate. A connected context-sharing worker is not proof that its coding agent is participating. Messages are retrieved by the working agent on tool calls, not injected into an idle conversation. Read-only explanation forks never approve work plans. Each workspace project must represent the intended shared repository; this advisory connector does not verify equivalent Git remotes across PCs. Path matching is conservative and case-insensitive, not filesystem/symlink enforcement. Unreported files, existing dirty changes, semantic conflicts, and direct edits outside the tools are not controlled. This connector does not install edit hooks or perform integration. The separate opt-in team mode does provide isolated worktrees, guarded writes, independent review, approved tests and dedicated-branch integration; see [TEAM_COORDINATION.md](TEAM_COORDINATION.md).

Existing installed clients need the updated package and a coding-client MCP reconnect to load the new tools. The immutable Homebrew release is not automatically republished when source changes.

### Open the Relay app

The source UX now guides setup one step at a time: Join team → Choose folder → Share conversation. Long conversation lists are searchable; Back and Cancel keep selection changes explicit and reset sharing consent. After sharing, the primary next action is Enable agent tools. A registered connection offers Finish agent connection with the remaining client-side checks, not an unverified green success state.

Returning users keep their saved setup during a workspace outage and get Retry connection rather than another join form. My agent / Team workspace and the selected team view are remembered in the browser tab. Search works across context, questions and activity; open discussions stay open through live updates. Paused/offline/manual responders have distinct explanations. Settings keeps advanced workspace administration separate from daily use. Installed clients require an updated package; to load changed companion Python code, Quit Relay and reopen the app (reloading the browser alone is not enough).

The latest source app keeps daily work in one window: **My agent** for connection controls and **Team workspace** for shared context, questions, and activity. Workspace addresses and administration links are under Settings. The initial browser approval is still a separate sign-in step; it does not recur when saved credentials remain valid.

After connecting a conversation, **Enable agent tools** opens an explicit approval dialog. Approval registers the connection's MCP server using the installed client's CLI, quietly in the background (Codex user scope / Claude repository-local scope). No token is passed in command arguments, no approval policy is relaxed, and unrelated Codex entries are not overwritten. Reconnect your coding client and check `/mcp` afterward: a registration receipt does not prove the running agent has loaded its tools. See the official [Codex MCP registration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

On macOS, open **Relay.app** from the Homebrew formula folder (the installer prints its path). Drag it to your Dock for next time. The app opens a private browser interface on your own computer.

1. Paste your invite link or workspace address and click **Connect workspace**.
2. In the workspace browser tab, join if needed and approve the matching computer code.
3. Back in the app, choose your repository and a readable Codex / Claude Code conversation.
4. Review sharing and click **Start sharing**. Use **Pause sharing** or **Quit Relay** whenever you want.

You can close the terminal and browser tab: syncing runs in the background. Open Relay again after restarting your computer; boot-time auto-start is not installed. Existing approvals are retained, but paused connections stay paused. Only your explicitly connected conversations are observed.

For this developer preview, **installation still uses one command**. The shared dashboard's Connect panel provides the correct command. With Python 3.11+ and Git already installed:

```sh
python -c "import urllib.request;exec(urllib.request.urlopen('https://YOUR_TEAM_HUB/install.py').read())"
```

Use your trusted workspace URL and `python3` where appropriate. Review `/install.py` first if desired. The installer downloads source-only files, validates the SHA-256 and exact file list, installs privately for your OS user, and opens the GUI without asking for a token in the terminal. It prints a reusable launcher path; Windows/Linux desktop shortcuts are not installed yet.

From a source checkout, launch the same app with:

```sh
python -m relay gui --url https://YOUR_TEAM_HUB
```

Invites work once and expire in 24 hours. Existing tokens and signed-in browser sessions continue working; old-token login is available as a fallback. Connecting the local app uses a five-minute browser approval and does not connect any conversation on its own. No token appears in URLs or command arguments.

The app stores credentials, selected-session connection files, and worker state in your private user application-data `Relay/companion` folder, outside the Homebrew Cellar. It does not change existing packages or agent settings. Old CLI connections in repository-local `.relay/` folders remain separate and untouched; do not connect the same source in both clients.

**Still required:** Tailscale access for this private workspace, a running hub, and installed/signed-in Codex or Claude Code. To let the working coding agent initiate searches/questions, use Enable agent tools in the latest source app, then reconnect your coding client. Older packaged clients still use the manual MCP instructions below. No GitHub integration, webhook, or separate model API key is required.

The old `python -m relay start` interactive CLI remains available for advanced use and prints its exact MCP registration command. It is no longer the default interface.

### Start the hub if it is not running

Requirements: Python 3.11+, Git, and the coding-agent CLI you want to connect. No runtime pip dependencies. The implementation targets Windows, macOS, and Linux; current execution verification is on Windows.

```sh
python -m relay hub
```

Open **http://localhost:7331**. Create a project and invite a teammate. The local owner signs in automatically on the hub machine unless `--public-origin` is configured. Each teammate gets an independent access token. The hub database and owner token live under `.relay/hub/` and are excluded from Git.

The 0.2 schema migration is additive. Existing projects, manual checkpoints, questions, answers, and ownership history remain intact. Existing manual sessions are labeled as manual records and are not silently attached to private source conversations.

## Homebrew installation (macOS / Linux)

For a private hub with Homebrew artifacts published, keep Tailscale connected and run:

```sh
brew tap relay/workspace https://YOUR_TEAM_HUB/homebrew/tap.git && brew install relay/workspace/relay-workspace
relay-workspace gui --url https://YOUR_TEAM_HUB
```

Homebrew must already be installed. The formula installs Python 3.13 and Git as dependencies, and exposes the command `relay-workspace` to avoid overwriting an unrelated `relay` executable. Your coding client and Tailscale are still separate prerequisites. Homebrew installation does not start a hub, change agent settings, or share a conversation. On macOS the formula also includes Relay.app. Open it in Finder and add it to your Dock. The GUI saves connection state in your user application-data directory. Review the formula at `/homebrew/relay-workspace.rb` before trusting it. This uses the standard [custom tap workflow](https://docs.brew.sh/Taps), not a homebrew/core entry or a public GitHub release.

Host maintainers publish an immutable, SHA-256-pinned source release and update the private tap with:

```sh
python -m relay.homebrew --data .relay/hub
```

It uses that hub's saved `network.json` origin and creates only managed artifacts under `<hub-data>/homebrew/`. Re-running without source changes is idempotent. Changed source advances the formula revision while retaining old releases. Clients use `brew update` and `brew upgrade relay/workspace/relay-workspace` to upgrade. The host must remain reachable for tap updates and uncached downloads.

Like the public source-only `/client.zip`, the tap and its pinned **application-source-only** releases are readable by anyone with network access to this private hub, without a Relay token. This avoids putting a token into a formula, Git configuration, or Homebrew download command. Workspace APIs, agent context, and credentials remain authenticated and are never bundled. No public Funnel or GitHub publication is configured. Only Git discovery/object files are exposed, never Git config, hooks, or arbitrary hub files.

## Connect Codex on your PC

First find the session in the specific repository you want to share:

```sh
python -m relay sessions --agent codex --repo "F:/projects/app"
```

Then attach its source session ID to your Relay project:

```sh
python -m relay connect --project "Your project" --name "Alice / authentication" --repo "F:/projects/app" --agent codex --source-session "SOURCE_SESSION_ID" --share-session --token-file .relay/hub/owner-token
python -m relay watch --config .relay/connector.json
```

Use your actual repository path. It must have at least one Git commit. On your teammate's computer, supply `--url https://your-relay-host`, omit the owner token file, and enter their personal token at the masked prompt. `RELAY_TOKEN` is also supported. Do not put tokens directly in command arguments.

## Connect Claude Code on your PC

```sh
python -m relay sessions --agent claude --repo "F:/projects/app"
python -m relay connect --project "Your project" --name "Bob / billing" --repo "F:/projects/app" --agent claude --source-session "SOURCE_SESSION_ID" --source-file "/absolute/path/to/selected-session.jsonl" --share-session
python -m relay watch --config .relay/connector.json
```

The discovery command lists transcript paths in Claude's repository-specific session directory. If your client uses a different storage layout, provide the selected transcript's absolute path directly. Relay verifies the session ID and repository in that file. It never scans all your conversations for content.

Use `--config .relay/second-session.json` for another source session with the advanced commands above. Existing connector configs are never overwritten. The watcher allows only one process per config file. Guided setup manages separate configs under `.relay/connections/` automatically.

`--share-session` is the one-time opt-in for ongoing sharing and automatic model calls for that selected session. The watcher runs until you stop it with Ctrl+C. Pause/resume from **Agent sessions** controls both new uploads and automatic responses; a result arriving after pause is rejected by the hub. A model request already in flight may finish locally, within its timeout.

## Let the agents ask each other

The watcher supplies automatic context and responses. The MCP server gives your working coding agent the tools to discover context gaps and ask peers. Run both against the same connector config.

Install Relay into the Python environment your agent uses if it cannot set a working directory:

```sh
python -m pip install -e .
```

Example **Codex** MCP configuration, using your real Python executable and absolute config path:

```toml
[mcp_servers.relay]
command = "python"
args = ["-m", "relay", "mcp", "--config", "F:/cowork/.relay/connector.json"]
cwd = "F:/cowork"
```

Example **Claude Code** `.mcp.json` configuration:

```json
{
  "mcpServers": {
    "relay": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "relay", "mcp", "--config", "F:/cowork/.relay/connector.json"]
    }
  }
}
```

The Claude example assumes Relay is installed in that Python environment. Use `python3` where appropriate. Add the server to your client's existing configuration without replacing other entries, then reconnect/restart the client as required. Relay does not edit global client configuration or silently grant tool permissions.

Suggested project instruction for both coding agents:

> Before changing a shared feature, use relay_project and relay_search. When rationale, requirements, interface details, or assumptions are missing or conflicting, use relay_clarify to ask the feature's owning source session. Verify the response against the current code and preserve uncertainty. Do not ask the developer to manually prepare a handoff: the watcher maintains context automatically. Do not recursively forward incoming clarification requests.

| Tool | Behaviour |
| --- | --- |
| `relay_project` | Discover features, ownership, source connections, activity, and conversations |
| `relay_search` | Search latest context records by keyword, with revision comparison |
| `relay_clarify` | Route a question to the owner; wait 45 seconds by default (up to 90 explicitly), then check `relay_inbox` |
| `relay_ask` | Queue a question without waiting |
| `relay_inbox` | Retrieve answers and queued/running/failed job status |
| `relay_history` | Read previous context versions |
| `relay_publish` | Optional explicit checkpoint, retained for compatibility |
| `relay_answer` | Optional direct answer from the owning working session |

The working agent decides when it needs clarification, using its tool instructions and judgment. Relay does not claim to detect every semantic conflict automatically. The responder uses a tools-restricted explanation fork, not the live coding conversation, and does not recursively ask peers or receive authority to edit their work.

## What happens automatically

1. **Observe:** the local watcher reads the selected source session every three seconds. It exports visible user/assistant text, tool activity summaries, file-change summaries, and completed-turn events. Raw reasoning blocks and raw tool-result bodies are excluded. Known credential patterns are redacted before upload. Event bodies are capped at 2,400 characters.
2. **Stream:** the hub stores events with source IDs and deduplicates retries. Server-sent events notify connected browsers of changes; the browser refreshes state without requiring a reload. The UI shows the most recent 250 captured events across the workspace. Older events remain in SQLite.
3. **Maintain understanding:** after a new completed turn, an explanation fork generates a structured record of implementation, decisions, constraints, rejected approaches, assumptions, verification, open questions, and evidence. Updates are debounced to at least 60 seconds per session and create immutable versions. A source cursor makes retries idempotent.
4. **Clarify:** an agent's question becomes a durable job addressed to the feature's owning source session. Its PC claims a three-minute lease, forks the completed source history, generates an answer, and returns evidence plus the response session ID. Questions remain queued while the source PC is offline. Failed jobs are visible and can be retried by the owning developer.
5. **Learn from the exchange:** subsequent automatic context synthesis incorporates answered clarification exchanges. Original explanations and source references remain available in Conversations.

There are separate observer and responder loops, so activity capture can continue while a model answers. Local event outboxes and pending results survive watcher restarts. The default limit is **12 explanation calls per rolling hour per connector**, shared by summaries and answers; `--max-calls-per-hour N` sets it when connecting. Each response is bounded to 120 seconds. Model usage consumes the developer's configured agent entitlement; it is not free merely because Relay has no API-key field.

## Provider adapters

- **Codex:** uses its local App Server over stdio, reads repository-scoped thread metadata and paginated persisted turns, and forks through the latest completed turn. Explanation forks are ephemeral, have read-only permissions, disable environment access for the turn, and decline tool/approval requests. The implementation is based on the installed CLI's generated protocol schema, including experimental thread pagination and fork fields. [App Server documentation](https://learn.chatgpt.com/docs/app-server)
- **Claude Code:** observes the explicitly selected JSONL transcript. For a clarification it makes a temporary local copy through the last completed response and calls `--resume <path> --fork-session` with structured output, built-in tools disabled, MCP tools denied, and hooks disabled for the invocation. The source transcript is unchanged. [CLI reference](https://code.claude.com/docs/en/cli-reference), [Session branching](https://code.claude.com/docs/en/sessions)

The retained history can include compacted summaries. Neither adapter promises recovery of forgotten context or access to hidden model state. If a source is missing, unsupported, unauthenticated, or inaccessible, the UI shows the worker error instead of manufacturing an answer. Client storage and protocol versions can change; verify with the smoke test below after client upgrades.

## Share the hub between PCs

For a small team using their own machines, a private Tailscale network can provide the shared HTTPS address. Both developers need Tailscale installed and signed in, and the hub machine must stay on with Relay running. Tailscale Serve is private-network sharing; do not use public Funnel for this setup. Enabling HTTPS requires a tailnet-owner approval and publishes the machine hostname in certificate transparency logs. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [HTTPS disclosure](https://tailscale.com/docs/how-to/set-up-https-certificates).

The hub can retain its approved external origin in `<hub-data>/network.json`:

```json
{"public_origin":"https://YOUR_MACHINE.YOUR_TAILNET.ts.net"}
```

This keeps remote-safe token login enabled across ordinary `python -m relay hub` restarts. It does not create the network proxy or automatically start Relay at boot. Invalid saved settings fail closed. Configure private Serve only after saving the origin and restarting the hub; otherwise an authenticated reverse proxy could be mistaken for a local browser. Never configure remote proxying with local owner bootstrap enabled.

Invite the teammate to the approved network/device with access limited to Relay's HTTPS port, and separately issue their Relay member token. Device sharing alone can grant more than one application according to network policies; do not treat it as an app-only invitation without checking those policies. Their first command is `python -m relay start --url https://YOUR_TEAM_HUB`; subsequent starts remember the address.

`localhost` on your teammate's computer means their own computer. Put the hub on a stable reachable machine and use an HTTPS reverse proxy or an encrypted private network.

With an independently configured TLS reverse proxy forwarding to `127.0.0.1:7331` and preserving Host:

```sh
python -m relay hub --public-origin https://relay.your-private-domain
```

This disables automatic owner login; use your personal token. The flag configures origin validation, not DNS, TLS, a tunnel, or a deployment. For an explicitly trusted encrypted private network you can bind to a private interface:

```sh
python -m relay hub --host 0.0.0.0 --public-origin http://PRIVATE_IP:7331
```

HTTP itself does not encrypt tokens or context. Do not expose this development HTTP server directly to the public Internet. No firewall, tunnel, or external deployment changes are made by Relay. Local connectors make outbound requests only.

## Boundaries and controls

- This is one trusted team workspace. All invited members can read all published projects. Feature ownership restricts updates and question responses; project-level confidentiality and SSO are not implemented.
- Only selected source sessions are shared. Redaction is best-effort and cannot guarantee detection of every secret or private passage. Don't connect a session containing unrelated sensitive material.
- Automatic context is labeled **agent-derived**, with explicit assumptions. A source reference identifies the conversation state used. The recorded Git SHA is the local checkout at observation, which may be newer than the source discussion; it is labeled accordingly. Git ancestry and semantic staleness are not automatically resolved.
- One connected source maintains one shared-context feature scope. For unrelated features, connect separate task conversations. Conversation summaries alone do not reserve paths; managed team mode separately enforces declared-path/interface reservations and revision-bound reviews.
- Codex observation currently hydrates up to 100 recent turns; Claude activity retains up to 2,000 normalized events per observation. A truncated source is flagged. Already observed events remain in the hub and local outbox.
- Explanation forks use the source history but do not re-run code or independently verify tests. They must state uncertainty and cite recorded evidence.
- Existing manually recorded data is preserved. Transferring a feature stops automatic updates from the previous source; the receiving session's own context scope is not silently overwritten.
- CLI credentials and worker state are under `.relay/`; GUI state is under your user application-data `Relay/companion` folder. Restrict these directories' OS permissions, especially on multi-user Windows hosts; Relay does not manage Windows ACLs. Back up the hub directory while the server is stopped.
- No remote shell, shared code editor, GitHub push hook, arbitrary PC control, or agent task launcher is included. Coding continues in your installed clients.

## Verification

See [the QA report](QA.md) for the current usability changes, test results, and remaining setup requirements.

Offline automated checks:

```sh
python -m unittest discover -s tests -v
node --check relay/web/app.js
```

Tests cover both developer identities, automatic worker updates from source events, clarification routing and answers, lease exclusivity, pause invalidation, failed-job retry, outbox recovery, SSE notifications, immutable context history, source scope checks, transcript filtering, and subprocess MCP communication. Provider-independent tests use explicit fixture adapters; passing them does not prove a live model responded.

Optional real-client smoke tests use your existing agent login and may consume model usage. They create their own isolated test session and preserve evidence under `.relay/smoke/`; they do not inspect your existing conversations:

```sh
python tests/live_smoke.py --provider codex --live
python tests/live_smoke.py --provider claude --live
```

Each test records a small design decision in a fresh source session, observes it, asks an explanation fork to recall the rationale, and checks that the source conversation did not change.

The full two-provider workflow can then be checked using those tests' evidence files:

```sh
python tests/live_workspace_smoke.py --codex-evidence .relay/smoke/CODEX_TEST_ID/verification.json --claude-evidence .relay/smoke/CLAUDE_TEST_ID/verification.json --live
```

This creates a separate QA hub and two developer identities, publishes automatic context from both providers, asks each source a question through MCP, runs the real responders, and verifies the answers are incorporated into new context versions. It uses additional model calls and writes results under `.relay/integration/`. QA records are not added to your main workspace.

Verified on Windows on 2026-09-13: 25 automated tests; real Codex 0.154.0 and Claude Code 2.1.267 source/fork checks with unchanged source conversations; and the complete two-provider workflow (six captured events, two automatic answers, both context records advanced to version 3). These checks used separate identities on one machine, not two physical PCs. macOS/Linux execution and a real cross-PC network remain unverified.
