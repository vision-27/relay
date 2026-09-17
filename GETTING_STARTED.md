# Relay: two people, one shared goal

## Choose the right mode

| What you want | Use |
| --- | --- |
| Agents split work, communicate, review, test and integrate | `relay-workspace team` |
| Coordinate a new agent but handle integration yourself | `relay-workspace team --manual` |
| Share understanding from an existing conversation without changing it | Relay browser app → My agent |

You do **not** select an old conversation or install a separate MCP for team mode.

## Before starting

Both computers need Git and an installed, signed-in Codex or Claude Code. Keep Tailscale connected and the shared hub computer awake. Use checkouts of the same Git repository; the folder names can differ. Start from compatible committed revisions. Automatic worktrees use committed HEAD: commit anything the agents need first, or leave your uncommitted work untouched and outside the shared run.

On a teammate's Mac, update to the latest published release (currently 0.6.2; check the upgrade output). Replace `YOUR_TEAM_HUB` with the shared workspace hostname:

```bash
brew update && brew upgrade relay/workspace/relay-workspace
relay-workspace team --url https://YOUR_TEAM_HUB
```

From a source installation, run this from the folder containing `relay/`, replacing the repository and workspace paths:

```powershell
python -m relay team --repo C:/projects/YOUR_REPOSITORY --url https://YOUR_TEAM_HUB
```

`localhost` means **this computer**. Teammates must use the HTTPS team address, not localhost. Relay reuses your saved identity for the same address; a new address may ask for your workspace token. Never put the token in a command or send it to your teammate. Upgrade/recovery details: [operations](docs/OPERATIONS.md).

## Start working

1. Confirm this session's repository root, or choose another. No global root changes.
2. Choose Codex or Claude Code. The first person creates a goal; the other joins **that same goal**, using its displayed ID if necessary.
3. Opt into automatic worktrees/helpers. The goal owner enters the test command and optional dependency-setup command, then approves the exact execution settings. Leave the test command blank for manual integration.
4. Describe the outcome normally. Keep both team terminals open. Relay plans, requests independent review, assigns tasks and starts a helper only when queued work makes one useful.

Paste launch commands as **one line at the normal shell prompt**, not into a running agent or Relay session. Once Relay says **Team ready**, input is requirements and `/commands`, not shell commands. To switch goals, use `/quit`, then run the new join command at the normal prompt. When joining, press Enter at "Anything to add" unless you intend to change the team's requirements: even a short message creates a new plan revision and requires another review.

Example goal: “Add an empty-state message and a keyboard-accessible refresh button to the reporting page, with tests. Preserve the current API.” You do not have to assign tasks to people or agents yourself.

Test command examples are project-dependent: `python -m unittest discover -s tests`, `npm test`, or `npm.cmd test` on Windows. An npm project may need an approved setup command such as `npm ci --ignore-scripts` (`npm.cmd ci --ignore-scripts` on Windows). These are examples, not commands Relay chooses or runs without consent. Commands are argument lists, not shell pipelines: `&&`, pipes, redirection and shell variable expansion are not interpreted. Project dependencies must be available or installed by the approved setup command in every candidate checkout.

Tests/setup execute trusted repository code with your account's OS permissions and may access files/network beyond the checkout. They are **not sandboxed**. Common token/password environment variables are omitted and output is redacted best-effort; this is not a security guarantee. Setup commands should install into the candidate/project, not modify global environments. No hidden dependency installation occurs.

## Follow progress

Open Relay → **Team workspace**. Shared goals show task status, ownership, the integration branch, approved checks and errors. Expand a task for review and test evidence. The page is a monitor; approving execution and controlling working agents remain in the team terminal.

| Control | Effect |
| --- | --- |
| Type a normal message | Adds an attributed requirement; the plan must be reviewed again |
| `/status` | Readable progress and the next action needed |
| `/help` | Controls and recovery guidance |
| `/pause` | Stops new work on this PC, interrupts its helper, cancels owned tests; keeps reservations |
| `/resume` | Continues the same still-running Relay session and its helper |
| `/quit` | Stops this PC's managed agents and tests; retains files and unfinished ownership |
| `/retry TASK_ID` | Explicitly retries a stopped failed integration after you resolve its cause |

The other developer's PC is not terminated by your local `/pause` or `/quit`. A shared goal needing a developer decision remains paused until someone replies and the revised plan is reviewed.

## Where the finished code goes

Automatic mode never edits the working folder you started from. Each agent/helper has a separate worktree. Peer artifacts are assembled in a candidate checkout, tested, and merged into the **dedicated local `relay/goal-...` integration branch** printed by the owner terminal. This branch belongs to the owner's repository; nothing is pushed to GitHub. You can inspect it with Git or your IDE and choose when to publish or merge it into your regular branch.

Only a matching successful test/merge receipt marks a task complete. This certifies the configured checks, not all possible correctness or security properties. Independent review remains between different developers; a helper cannot replace the second developer's approval.

## When something stops

- **Waiting for review:** make sure both people joined the same goal and their terminals are open. Merely sharing a conversation does not enroll a working agent.
- **Tests failed:** Relay returns corrections to the original worker, at most three attempts. The latest result is visible in the task. After three attempts, a developer decision is required.
- **Dependencies/setup failed:** check the preserved candidate, the approved setup command and network. Resolve the environment issue before `/retry TASK_ID`.
- **Merge conflict or outside changes:** no automatic conflict resolution, reset, deletion or ownership stealing. Inspect the preserved checkout first.
- **Brief network outage (0.6.1):** edits are blocked immediately and connection checks retry automatically with bounded backoff. The same session resumes connectivity; model turns are not replayed. Keep the terminal open. An interrupted test may need inspection and `/retry TASK_ID`; interrupted agent work can be reconciled with explicit `/pause` then `/resume`. Old clients require manual `/resume`.
- **Explicit pause, permissions error, or stopped provider:** resolve the reported cause and use `/resume` in the existing terminal. An explicit pause is never undone by automatic reconnection. Never start duplicate controllers to bypass reservations.
- **Process crash or terminal already closed:** `/resume` is an in-process command, not crash recovery. The private run record and candidate/branch remain. Automatic integration ownership is not transferred to a new controller silently. Reconcile its Git state and use the manual acceptance/recovery workflow; restarting an interrupted automatic integration controller is a remaining limitation of this release. Do not delete its private run directory to “fix” ownership.

Manual integration uses `/export TASK_ID` to save the reviewed artifact bundle, then `/accept TASK_ID` and `/confirm TASK_ID your verification note` after integrating/testing. `/recover TASK_ID` plus `/confirm` releases stopped implementation ownership only after explicit reconciliation; it does not undo or merge files.

## Which status should I trust?

Use `/status` or the browser's shared-goal status and test receipts. Agent prose describes what the agent knew when it spoke and can become stale while another PC tests or integrates. In 0.6.1 the terminal prints **Relay status (hub)** as authoritative progress; a completed goal no longer wakes agents just to process join notices. "Complete" means all scoped tasks have passed their configured acceptance gate, not that arbitrary production behavior has been proven. Team messages stay within the enrolled goal; cross-goal file reservations still prevent overlaps.

## Windows terminal flashes

Relay's background children use hidden launch flags. A window titled `.codex/packages/.../codex-code-mode-host.exe` is the Codex app's own helper, not a Relay working agent. Do not delete it or terminate it while it supports a running session. The previously observed app-level window issue was not fixed by Relay's launch flags.
