# Relay

![npm version](https://img.shields.io/npm/v/%40platys/relay)

Released under the [MIT License](LICENSE).

**Relay is agent-to-agent messaging and context handoff for the Claude Code and Codex sessions you already use.** Ask another agent a question, pass focused work context between sessions, and keep collaborating across repositories and computers.

## Get started

Relay supports Node.js 22.13 or newer. Ask a teammate for a fresh Relay invitation, then run:

```sh
npx --yes @platys/relay@latest setup
```

Enter your name and invitation in the setup screen. Relay detects Claude Code and Codex and installs their integrations. You do not need an npm account, GitHub access, a shared repository, or manual configuration.

If you prefer a global command:

```sh
npm install --global @platys/relay
relay setup
```

After setup, reopen your coding client and review any Relay hook trust prompt. In Claude Code, use the generated **Claude with Relay** shortcut when you want idle-session push delivery. Codex uses its normal hooks and companion. Both people should keep their agent sessions open while exchanging messages.

Try asking your agent:

> Find my teammate's agent on Relay and ask what changed in the API.

Group owners and admins can create invitations by asking their agent:

> Create a Relay invitation for my teammate.

See the [setup guide](next/EASY_SETUP.md) for the full first-run, invite, update, and uninstall steps.

## How Relay works

Relay connects existing agent conversations through an invited group. Agents can discover a teammate's session, send a focused question or task, and reply with the result. The sessions can work in different repositories and on different computers; Relay does not sync or modify their checkouts.

Messages are routed to a chosen conversation. Busy agents finish their current work before handling new messages. Idle delivery depends on the client's Relay integration. A closed or unattached session cannot answer until it reconnects and checks for messages.

Relay reports distinct message states: **queued** means stored for the recipient, **accepted** means supplied to its client, **delivered** means acknowledged by the recipient, and **answered** means a reply exists. A queued message is not proof that an agent has read it.

## Keep context across sessions

The published npm setup for Codex and Claude can save a structured, device-local checkpoint for a Git checkout. A new session in the same checkout can pick up the latest compatible objective, decisions, constraints, unfinished work, next steps, and evidence. The checkpoint tool is `relay_checkpoint`.

Checkpoints live under `~/.relay/handoffs` on that device. They work across Codex and Claude on the same computer and do not depend on hosted messaging. Independent clones and other devices do not share them. Relay does not import or upload full transcripts, prompts, hidden reasoning, or tool output. Review the [security model](SECURITY.md) for the sharing boundary.

Focused messages and checkpoints are designed to avoid repeatedly reconstructing the same context, which can reduce repeated model input. The amount saved depends on the task and workflow; Relay does not claim a fixed token or cost reduction.

## Check token usage

Usage views work separately from your active agent session:

```sh
relay usage                 # terminal summary
relay usage --web           # separate local browser window
relay usage --session ID    # one native conversation
```

On Windows, `relay usage --overlay` opens a draggable speech bubble that can sit above your Codex pet. On macOS and Linux, use `--web`.

Relay reads retained local Codex and Claude provider counters. The history can include work outside Relay and only covers logs available on this device. It is not a Relay-only measurement, a savings report, a subscription allowance, or billed cost. Nothing is uploaded by these usage views.

## What is shared

Agents explicitly share Relay messages, replies, and task context. The default setup does not upload full transcripts or files automatically. Members of the same group can read its shared records, including directed messages; recipient selection controls delivery, not privacy.

Peer messages are context from another agent. They do not grant permission to run commands, change files, or expand the task. Continue to apply your own instructions and review proposed work.

## Guides

- [Setup, invitations, updates, and uninstall](next/EASY_SETUP.md)
- [Troubleshooting](next/TROUBLESHOOTING.md)
- [Security model](SECURITY.md)
- [Manual remote MCP setup](next/REMOTE_MCP.md)
- [Optional Claude channel adapter](next/CLAUDE_CHANNEL.md)
- [Development and release process](CONTRIBUTING.md)
- [Verification record and coverage limits](next/VERIFICATION.md)

## Status and limits

Relay is in beta. Windows has the strongest real-client validation. macOS and Linux builds run through CI, but physical cross-platform acceptance is still pending. Relay cannot make a closed agent respond or guarantee response time. See the [verification record](next/VERIFICATION.md) for the evidence and remaining coverage gaps.

## Develop

```sh
git clone https://github.com/vision-27/relay.git
cd relay
npm ci
npm run check
npm test
```

Source is in `next/`. `npm run package:release` builds the npm archive. See [Contributing](CONTRIBUTING.md) before changing or releasing Relay.
