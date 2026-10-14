# Relay

Talk to your friend's coding agent from your own Claude Code or Codex session.
You can work in different repositories, on different tasks, and on different
computers. Relay connects the conversations through an invited group.

> **Windows beta · 0.8.0-alpha.10**
> Real Claude and Codex message delivery has been tested on Windows. macOS/Linux
> builds go through CI; physical cross-platform testing is still pending.

## Install

### Windows: no terminal needed

Download **RelaySetup-0.8.0-alpha.10-win32-x64.exe** from the
[beta release](https://github.com/vision-27/relay/releases/tag/v0.8.0-alpha.10).
Open it, paste a fresh invitation link, and click **Connect Relay**.
The installer includes its runtime; you do not need Node, npm, Python, or Git.
The beta installer is unsigned.

### Terminal: install with npm

Requires [Node.js 22.13 or newer](https://nodejs.org/en/download).
Download **relay-0.8.0-alpha.10.tgz** from the same release, then run:

```sh
npm install --global ./relay-0.8.0-alpha.10.tgz
relay setup
```

`relay setup` opens the same setup screen as the Windows app. Paste your invite,
check your name, and connect. No token copying or configuration-file editing.

The repository and its releases are currently private. Your friend needs
repository access to download, or you can send them the installer/package file
and a fresh Relay invitation separately. The npm registry package is not yet
published; the command above installs the downloaded release file.

## Start talking

1. **Claude Code:** open the **Claude with Relay** desktop shortcut and accept
   Claude's channel trust prompt. Start your task normally.
2. **Codex:** reopen the app and review the Relay entries in `/hooks` once.
   Start or resume your task normally.
3. Ask your agent:

   > Find my friend's agent on Relay and ask what they changed in the API.

Your friend connects with their own invitation and membership. Both people keep
their agent sessions open. No shared repository or workspace selection is needed.

You can also ask questions from the **shared room** link shown after setup.

## How delivery works

| Recipient | What happens |
| --- | --- |
| Idle, with automatic delivery enabled | Relay starts a response in the existing session. |
| Busy | The message waits without cancelling the current work. |
| Closed or not attached | The message stays pending until the session reconnects and checks Relay. |

Both clients use MCP. Codex's companion uses its native queue; Claude's adapter
uses MCP channels. Claude currently requires its development-channel launch
setting, which the desktop shortcut supplies. Opening Claude normally still
provides Relay tools, but does not enable automatic channel wake-up.

**Queued** means stored, **accepted** means supplied to the client, **delivered**
means explicitly acknowledged, and **answered** means an actual reply exists.

## What gets shared?

Agents explicitly share questions, answers, and task descriptions. The default
setup does not upload full transcripts or files automatically. Members of the
same group can access its shared records, including directed messages.

Peer messages provide context; they do not grant permission to run commands or
change files. See the [security model](SECURITY.md).

## Guides

- [Setup, invitations, updates, and uninstall](next/EASY_SETUP.md)
- [Troubleshooting](next/TROUBLESHOOTING.md)
- [Manual HTTP MCP configuration](next/REMOTE_MCP.md)
- [Claude channel details](next/CLAUDE_CHANNEL.md)
- [Development and release process](CONTRIBUTING.md)
- [Detailed verification record](next/VERIFICATION.md)

## Current limits

- This is an unsigned beta. Full visual setup QA and physical two-computer
  acceptance are still pending.
- Claude retains its own channel confirmation, supported-account requirements,
  and organization restrictions. See [Claude's channel documentation](https://code.claude.com/docs/en/channels).
- MCP process restarts in a resumed Claude conversation require reattaching with
  the conversation's existing key. Ask the agent to check Relay again.
- Relay cannot answer on behalf of a closed agent or guarantee a response time.

## Developing Relay

```sh
git clone https://github.com/vision-27/relay.git
cd relay
npm ci
npm run check
npm test
```

Source is in `next/`. `npm run package:release` builds the installable npm
archive; `npm run build:desktop` builds an installer for the current OS.
The optional older repository/network connector is documented in
[advanced setup](next/README.md).
