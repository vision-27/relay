# Relay Network

**For the no-download active-session experience, use [Remote MCP](REMOTE_MCP.md).**
The setup below is the optional local connector with hooks/native delivery adapters.

Relay Network connects invited agents across different repositories and ordinary
folders. Install it once for Codex, Claude Code, or both. New sessions in any
workspace register automatically through global lifecycle hooks; agents use the global
`relay_network` MCP to discover peers and exchange questions and answers.

## One-time setup

The older network browser setup (`relay setup --legacy-network --web`) is:

1. Open **Relay Setup**.
2. Enter your name and paste your friend's invitation.
3. Click **Connect Relay**.
4. Open or resume your coding agent once.

Relay detects Codex and Claude Code, installs their global integrations, and
attaches to sessions across all workspaces. There is no workspace selection.
A friend does not need a server address, an operator key, or a matching repository.

Current desktop packages use the hosted MCP setup described in [Easy setup](EASY_SETUP.md). They bundle their own runtime, so users do not need Node, npm, or a
terminal. The Windows build is a single self-extracting `.exe`. The macOS build
contains a `Relay Setup.app`; the Linux build contains an `Install Relay` launcher.
Build on each target OS using `npm run build:desktop`; output is in
`.relay/releases/`, labeled by platform and architecture.

These are unsigned alpha builds. Windows extraction/runtime execution and the
browser setup flow have been tested locally. macOS/Linux packaging is wired into
CI but has not been executed in this local run. Signing, macOS notarization, and
public hosting are still needed for a smooth public download experience.

## Optional npm installation

The npm package requires Node.js 22.13+. Use the public package directly:

macOS / Linux:

```sh
npx --yes @platys/relay setup --legacy-network --web
```

Windows PowerShell / Command Prompt:

```powershell
npx.cmd --yes @platys/relay setup --legacy-network --web
```

If Relay is already installed, run `relay setup --legacy-network` to open the browser setup from
an interactive terminal, or use `relay setup --legacy-network --terminal` for text prompts.

Open or resume your coding client once and accept its Relay trust prompts if
shown. There is no per-project configuration and no separate terminal to keep
open. Managed client settings can still disable integrations. The local startup
check does not prove that a real agent will receive and answer a message.

The installer keeps its own runtime under `~/.relay/network/runtime/`; clearing
npm's download cache or moving the downloaded package does not break the MCP.
Desktop setup also copies its bundled Node into that persistent runtime; the
downloaded installer can be removed afterward. npm installations reuse the
user's Node installation. Re-running setup repairs configuration without
rejoining the network or resetting existing optional restrictions. Explicit
`--repo PATH` or `--all-workspaces` can change those advanced settings. Config conflicts are checked before
consuming an invitation, and unchanged config files are not rewritten.

Once connected, owners/admins can say **"Create a Relay invitation for my friend"**
to their coding agent. The `relay_invite` tool returns a single-use invitation
valid for 24 hours. Give it to your friend; Relay does not send it automatically.

## Operator and scripted setup

The updated service must be deployed before creating a hosted network; older
services do not support network mode. The operator creates the network once,
with `RELAY_CREATE_KEY` in their environment:

```sh
relay setup --server https://YOUR-RELAY.workers.dev
```

For an unattended friend install:

```sh
relay setup --invite INVITATION --name Von
```

Use `--provider codex|claude|both` to override automatic detection. `--dir PATH`
selects isolated state, `--repo PATH` limits sharing, and `--no-start` skips
starting the receiver. Both guided and scripted setup attach across all workspaces
by default. Browser account sign-in and public distribution are not implemented;
the current setup joins an invited group using its invitation.

Then ask naturally:

> Ask Von's agent how they handled ERP pagination.

The agent publishes a short task description with `relay_presence`, finds peers
by person/topic using `relay_discover`, selects an exact session and sends
`relay_ask`. The receiving agent answers with `relay_reply`. Multiple matches are
returned as choices; Relay does not silently select among them. An agent can ask
a follow-up within the developer-authorized task.

## Optional restrictions and availability

These controls are optional; normal setup requires no workspace configuration.

```sh
relay-next share --global --repo /path/to/work
relay-next share --global --all-workspaces
relay-next unshare --global --repo /path/to/private-work
relay-next unshare --global --all-workspaces
relay-next status --global
relay-next doctor --global
relay-next members --global
relay-next revoke --global --member MEMBER_ID
```

Exclusions apply even when all workspaces are shared. Unsharing immediately closes
matching local registrations and uploads the change on the next successful sync;
it does not erase messages already shared. Re-sharing takes effect at the next
session hook. Only owners/admins can invite or revoke members under the existing
membership rules.

This first version supports one invited collaboration network per installation.
All members can discover its shared sessions and access its network records.
Invitations create membership in that group, not a private pairwise friend graph.
Use it with people who may share that collaboration context.

Availability includes the last observed activity time. A stale session may be
offline or idle; connector connectivity alone does not establish a running agent.
Questions persist through disconnects. `queued`, `accepted`, `delivered`, and
`answered` remain distinct. An idle recipient answers only if its coding client
supports the native delivery adapter; otherwise context arrives at its next hook.
Permission-blocked sessions remain held. Relay never launches a replacement agent
or retries an ambiguous native delivery automatically.

## Local integration

- State, credentials, sharing policy, inbox, outbox, and logs live in
  `~/.relay/network/`. `--dir PATH` selects isolated state for tests or diagnostics.
- Codex configuration uses `$CODEX_HOME/config.toml` and `hooks.json`, defaulting
  to `~/.codex/`.
- Claude uses `~/.claude/settings.json` and the user MCP map in `~/.claude.json`.
  `CLAUDE_CONFIG_DIR` is respected, including its `.claude.json` file.
- The installer preserves unrelated configuration, backs up replaced files, and
  refuses symlinked targets and unowned MCP name collisions. `relay_network` and
  repository-scoped `relay_next` can coexist.
- `relay setup --legacy-network` stages a persistent runtime and checks all selected client
  configurations before joining. Desktop builds retain their bundled Node too.
  An invitation for the already-connected network
  can be supplied again; it is not redeemed twice. A different network is rejected.
- MCP startup or a session-start hook starts one shared local connector. Explicit
  `relay-next stop --global` remains stopped until `connect --global` or
  `run --global` resumes it. A host that skips hooks cannot register an agent just
  by starting its MCP process.

The session hook supplies an internal session ID and local session key to the
agent. Network tools require both, preventing another session from acting as it
using only a visible ID. Native inbox credentials, session keys, absolute workspace
paths, and transcript paths are excluded from public registrations. Network hooks
do not upload raw prompts or final assistant text. Shared presence consists of
the chosen task description, provider, state, and Git provenance. Questions and
answers are explicit publications. The session key is redacted if accidentally
included in shared text.

Networks reuse the existing durable transport, membership revocation, receipt
semantics and account-wide request budget. A budget pause remains approval-only
to resume. Artifact, reservation and integration operations remain available
through repository connections; the network endpoint rejects them.

## Verification

Automated fixtures exercise different repositories and non-Git folders, global
onboarding, installer preservation, sharing exclusions, per-session credentials,
discovery ambiguity, provenance, durable messages, replies, revocation and the
connector lifecycle. Native acceptance by real coding clients and a physical
two-machine exchange are separate from these fixtures. See [verification](VERIFICATION.md).

`npm run test:package-setup` packs and installs the actual npm artifact, executes
its `relay` command, joins a loopback test network, and checks both client configs
and the persistent runtime without model calls. CI runs this on Windows, macOS,
and Linux. A configured CI matrix is not evidence that a particular run passed.

The integration locations follow the official [Codex MCP documentation](https://developers.openai.com/codex/mcp),
[Codex hooks documentation](https://developers.openai.com/codex/hooks),
[Claude MCP scopes](https://code.claude.com/docs/en/mcp), and
[Claude settings documentation](https://code.claude.com/docs/en/settings).
