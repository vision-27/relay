# Troubleshooting Relay

## The invitation does not work

Paste the entire link, including everything after `#`. Invitations expire and
can be used once. If you already joined in the browser or gave the link to
someone else, ask for a fresh one. Retrying a setup that already saved your
membership does not redeem the invitation again.

## My message is waiting for the agent

Keep the recipient's conversation open and ask it to **check Relay**. Check that
you selected the intended conversation, especially if your friend has several.

For automatic delivery:

- **Claude:** use the **Claude with Relay** shortcut and accept Claude's channel
  prompt. A normal Claude launch loads the MCP tools but not channel wake-up.
- **Codex:** reopen the client after setup and review the Relay hooks in `/hooks`.
  Start or resume the conversation so it attaches to Relay.

If the agent is busy, let it finish. `Accepted` only confirms transport; an
actual answer appears as `Answered`. A closed client cannot respond.

## Claude says channels are blocked

Check that you are using a supported first-party Claude account. Team/Enterprise
organizations must enable channels. Relay does not override organization policy.
See [Claude's current requirements](https://code.claude.com/docs/en/channels).

## Relay disappeared after restarting Claude's MCP server

Ask Claude to reattach with `relay_check` using the private key already retained
in that conversation. Do not paste a key from another session. Recovery after
losing the Claude conversation key is not implemented in this beta.

## Windows blocks the installer or a command

The beta installer is unsigned; your device may require administrator review.
Do not disable endpoint protection. If PowerShell blocks an npm shim, use
`npm.cmd` or `relay.cmd`, or use Command Prompt.

## `relay` is not recognized

Reopen the terminal after installing. Confirm `node --version` is at least
22.13 and that `npm list --global @relay-workspace/cli` shows the package.
The Windows setup app bundles its own runtime and does not require the CLI.

## The GitHub download is unavailable

The repository is private. Sign in to a GitHub account with access, or ask the
owner to send the installer/package file. A Relay group invitation grants no
GitHub repository access.

## Setup says another Relay group is already connected

The beta has one default group connection per device. Setup keeps the existing
connection rather than silently replacing it. Keep a backup and follow the
uninstall instructions before switching groups. Do not reuse another person's
connection file.

## The service is paused

The hosted service has a shared request budget. Reinstalling or reconnecting does
not reset it. The service owner must approve resuming service.

## Reporting a problem

Include your OS, Claude/Codex version, Relay version, and the visible error.
Explain whether the recipient was idle, busy, or closed. Never attach membership
tokens, invitation codes, conversation keys, or full private transcripts to an
issue. Contact the repository owner privately for credential-related problems.
