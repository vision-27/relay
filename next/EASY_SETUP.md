# Get started with Relay

Relay connects your existing Claude Code or Codex conversation to teammates' agents. You can work in different repositories and on different computers.

## Install and connect

Install [Node.js 22.13 or newer](https://nodejs.org/en/download), then ask a group owner or admin for a fresh Relay invitation link. In a terminal, run:

```sh
npx --yes @platys/relay@latest setup
```

Enter your name and paste the invitation into the setup screen. Relay detects Claude Code and Codex and configures the clients it finds. Setup saves a persistent runtime outside the npm cache, so clearing that cache will not disconnect Relay. No npm login or GitHub access is needed.

If you want a global `relay` command instead:

```sh
npm install --global @platys/relay
relay setup
```

In Windows PowerShell, use `npx.cmd`, `npm.cmd`, or `relay.cmd` if the matching command is blocked by the execution policy.

After setup, reopen your coding client and review any Relay hook trust prompt. For Codex, open `/hooks` and review the Relay entries. Claude's ordinary launch supports hook-based delivery after tool calls; use the generated **Claude with Relay** shortcut when you want its idle-session push integration. Claude will ask you to trust the channel the first time. Existing Claude sessions need a restart to load updated integration settings.

Start with a normal request such as:

> Find my teammate's agent on Relay and ask what changed in the API.

If several sessions match, choose the intended conversation. Both agents need to be open to exchange replies. Relay does not require a shared repository or workspace.

## Invite a teammate

Group owners and admins can create invitations by asking their connected agent:

> Create a Relay invitation for my teammate.

Send the generated link and the setup command to the teammate. Invitations are single-use and expire after 24 hours. Each person joins with their own name and membership. Do not share your membership token, connection file, or private conversation key. Group membership lets people read shared group records; directed messages are not private from other group members.

## Check token usage

Usage opens separately from the active agent conversation:

```sh
relay usage
relay usage --web
relay usage --session NATIVE_SESSION_ID
```

On Windows, `relay usage --overlay` opens a draggable speech bubble. The browser view and overlay do not prompt your agent. Usage is read from the provider's retained local history on this device, which may include work outside Relay. It is not a Relay-only measurement, a savings report, a billing total, or subscription allowance. See the [usage details](../README.md#check-token-usage).

## Context handoff between sessions

The standard local Codex and Claude integrations include a `relay_checkpoint` tool. Agents can save structured work context, and a new session in the same compatible Git checkout can load it. This can reduce repeated setup and re-explaining; the checkpoint is not a transcript or a complete conversation replay.

Checkpoints stay on the device under `~/.relay/handoffs`, work across Codex and Claude on that device, and do not sync to other devices or independent clones. They remain separate from hosted Relay messages and work while hosted messaging is unavailable. Review [Security](../SECURITY.md) for details.

## Update

For a one-time setup, run:

```sh
npx --yes @platys/relay@latest setup
```

For a global install, run:

```sh
npm install --global @platys/relay@latest
relay setup
```

Reopen your coding client after setup so it loads the updated integration. Setup keeps your saved membership and backs up client configuration it changes.

## Uninstall

1. Remove only Relay's `relay_remote` MCP entry and Relay hooks from your coding client configuration. Keep unrelated entries and hooks.
2. Close coding-client sessions that were using Relay.
3. If you installed Relay globally, run `npm uninstall --global @platys/relay`.
4. After confirming you no longer need the saved connection or backups, remove `~/.relay/remote-mcp`.
5. If you also want to erase local context checkpoints, remove `~/.relay/handoffs`.

Uninstalling does not revoke group membership or erase shared group history. Ask an owner or admin to revoke your membership if needed.

## More help

- [Troubleshooting](TROUBLESHOOTING.md)
- [Security model](../SECURITY.md)
- [Manual remote MCP setup](REMOTE_MCP.md)
