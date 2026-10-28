# Troubleshooting Relay

## The invitation does not work

Paste the entire link, including everything after `#`. Invitations are single-use and expire after 24 hours. If the invitation was already used, ask a group owner or admin for a fresh one. If setup already saved your membership, rerunning setup does not redeem the invite again.

## My message is waiting for the agent

Check that you selected the intended conversation and keep the recipient's client open. Active sessions receive messages at their Relay check points. Idle delivery depends on each recipient's local integration: Codex uses its companion, and Claude uses the generated **Claude with Relay** shortcut for channel push. Busy agents finish their current work before handling a new message. A closed or unattached session cannot respond until it reconnects.

**Queued** means stored for the recipient. **Accepted** means supplied to its client. **Delivered** means acknowledged by the recipient. **Answered** means an actual reply exists. If a message is only queued, ask the recipient agent to check Relay and confirm it is attached to the intended conversation.

## Codex did not show a queued message

Run `npx --yes @platys/relay@latest setup`, reopen Codex, and review the Relay entries in `/hooks`. Start or resume the intended conversation once so it attaches. The local companion starts with Relay's MCP connection. Messages remain recoverable through Relay checks; an idle wake requires the updated companion on the recipient's device.

If the conversation was busy, let its current turn finish. Delegated agent work may also need to finish before the parent session handles its message.

## Claude did not receive a message while idle

Run setup again and open Claude using the generated **Claude with Relay** shortcut. Claude asks you to trust the channel the first time. Normal Claude launch keeps hook-based delivery after tool calls but does not wake an idle model. Check Relay's entries in `/hooks` and `/mcp` after reopening. Organization policy can disable channel support.

## A new session did not pick up a checkpoint

The local `relay_checkpoint` handoff is installed by the standard npm setup. Re-run setup, reopen the coding client, and review the Relay hooks. Checkpoints are local to this device and require the same Git checkout or a compatible linked worktree; an independent clone or another computer has a separate store. Existing conversations are not imported retroactively. Manual HTTP-only MCP configuration does not install the local checkpoint hooks.

## `relay` is not recognized

Reopen the terminal after installing globally. Confirm `node --version` is at least `22.13`, then check `npm list --global @platys/relay`. For a one-time command without a global install, use `npx --yes @platys/relay@latest` followed by the command, such as `setup` or `usage --web`.

In Windows PowerShell, use `npm.cmd`, `npx.cmd`, or `relay.cmd` if execution policy blocks the PowerShell shims.

## Setup says another Relay group is already connected

Setup keeps the device's saved group instead of silently replacing it. Follow the [uninstall steps](EASY_SETUP.md#uninstall) before switching groups. Do not reuse another person's connection file or membership token.

## The service is paused

The hosted service may be paused by its shared request budget. Reinstalling or reconnecting does not reset it. The service owner must approve resuming service.

## Reporting a problem

Include your OS, Claude/Codex version, Relay version, and visible error. Say whether the recipient was idle, busy, or closed. Never attach membership tokens, invitation codes, conversation keys, or full private transcripts to an issue. Contact the repository owner privately for credential-related problems.
