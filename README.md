# Relay

[![Relay checks](https://github.com/vision-27/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/vision-27/relay/actions/workflows/ci.yml)

Shared understanding and coordinated coding for developers using Codex and Claude Code on different computers.

**Current version: 0.6.2.** Windows, macOS and Linux are supported targets. This patch fixes a reproduced Windows HTTPS trust-chain failure and is active on the hub and Windows companion, with private Homebrew revision 12 published. Two physical Windows–Mac trials completed on 0.6.0; physical Mac sleep/wake acceptance of the updated client remains pending. See [release notes](CHANGELOG.md) and [verified results](POLISH_QA.md).

## What Relay does

You and your teammate describe a shared goal. Relay plans the work, asks the other developer's agent to review the plan, assigns non-overlapping tasks, transfers context and questions, and routes code artifacts for independent review.

With per-run approval, Relay creates isolated Git worktrees, launches up to one additional helper per computer, runs the tests you approve, and integrates passing changes into a dedicated local branch. Your original folder, uncommitted work and existing conversations stay untouched. Nothing is automatically pushed or merged into your current branch.

## Choose a workflow

| You want to… | Start here |
| --- | --- |
| Let new agents collaborate on a shared goal | `relay-workspace team` |
| Coordinate new agents but integrate changes yourself | `relay-workspace team --manual` |
| Share understanding from an existing conversation | `relay-workspace gui` → My agent |

Team mode does **not** need an existing-conversation picker or a separately registered MCP. Conversation sharing is a different, read-only workflow; registering its tools alone does not enroll a working agent in team mode.

## Get started

Both developers need Git, an installed and signed-in Codex or Claude Code, access to the same running Relay hub, and checkouts of the same Git project. For a private Tailscale hub, keep Tailscale connected and the host awake. `localhost` always means your own computer, not your teammate's.

### Install

Use the installation command provided by your workspace's **Connect** panel. For a private Homebrew tap, replace `YOUR_TEAM_HUB` with your actual workspace hostname and paste the whole command on one line:

```bash
brew tap relay/workspace https://YOUR_TEAM_HUB/homebrew/tap.git && brew install relay/workspace/relay-workspace
```

Windows/Linux users can use the workspace's user-local installer. From a verified source checkout, Python 3.11+ can run Relay without runtime pip dependencies:

```sh
python -m relay --help
python -m relay gui --url https://YOUR_TEAM_HUB
```

Do not run `pip install relay`: that name belongs to an unrelated project. This project has not been published to PyPI. Homebrew installs Python and Git, but not your coding client or Tailscale.

### Work together

Open your coding repository in a **normal terminal**, then run:

```sh
relay-workspace team --url https://YOUR_TEAM_HUB
```

1. Confirm or change the repository root for this run. No global root is saved.
2. Choose your agent. One developer creates a goal; the other joins its displayed goal ID.
3. Approve the scope and, optionally, isolated worktrees/helpers and exact test/setup commands.
4. Keep the team terminals open. Add requirements in plain language; Relay handles assignment and peer communication.

To join a particular goal, use this as one line in your normal shell, **not** inside a running Relay session:

```sh
relay-workspace team --goal GOAL_ID --url https://YOUR_TEAM_HUB
```

At “Anything to add,” press Enter unless you intend to change the requirements. For source installs, substitute `python -m relay` for `relay-workspace`.

## Everyday controls

| Command | Meaning |
| --- | --- |
| `/status` | Current hub state, tasks and integration results |
| `/pause` | Stop new local work; keep ownership and files |
| `/resume` | Resume the same still-running session after resolving the cause |
| `/quit` | Stop this computer's managed agents; retain results and unfinished reservations |
| `/help` | Show controls and recovery guidance |

Open **Team workspace** to follow progress. Trust hub status and test receipts over older agent prose. “Complete” means the configured acceptance gates passed; inspect the dedicated `relay/goal-...` branch before choosing to merge or publish it.

Temporary network failures block guarded work and retry connectivity automatically. They do not replay model input, discard ownership, or undo a deliberate pause. Keep the terminal open. See [recovery and upgrade instructions](docs/OPERATIONS.md).

## Safety and current limits

- Managed agents use scoped file tools, not arbitrary shells, deletions or settings edits. Other editors and processes are not intercepted.
- Tests/setup run trusted repository code with your OS permissions. They are **not sandboxed**; approve commands carefully.
- Declared path/interface conflicts are gated. Semantic conflicts still require review and tests; “conflict-free” is not guaranteed.
- The hub must stay reachable. Automatic takeover after an integration-controller process crash is not implemented.
- All invited members can read the workspace's shared context. Share selected conversations deliberately; secret redaction is best-effort.
- Existing coding conversations are never silently recruited. Agent login/model billing remains with each developer.

## Documentation

- [Two-person quickstart](GETTING_STARTED.md)
- [Upgrades, reconnects and troubleshooting](docs/OPERATIONS.md)
- [Physical Windows–Mac acceptance checklist](RELIABILITY_ACCEPTANCE.md)
- [Architecture and code map](docs/ARCHITECTURE.md)
- [Team coordination and automation boundaries](TEAM_COORDINATION.md)
- [Advanced hub, installer and MCP reference](REFERENCE.md)
- [Release notes](CHANGELOG.md), [QA evidence](POLISH_QA.md), [UX review](UX_REVIEW.md)
- [Development and testing](CONTRIBUTING.md), [security boundary](SECURITY.md)

## Development

From the repository root:

```sh
python -m unittest discover -s tests -v
```

The ordinary suite uses isolated temporary hubs/repositories and test providers. Native agent and physical-device checks are separate opt-in workflows. GitHub Actions checks Windows, macOS and Linux; the workflow file alone is not evidence of passing CI. Use the matching commit's actual result.

Source: [vision-27/relay](https://github.com/vision-27/relay). See [GitHub releases](https://github.com/vision-27/relay/releases) for tagged snapshots and [Actions](https://github.com/vision-27/relay/actions) for the actual CI result of a commit. This repository is private; access must be granted by its owner.
