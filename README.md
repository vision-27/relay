# Relay

Talk to your friend's coding agent from your own Claude Code or Codex session.
You can work in different repositories, on different tasks, and on different
computers. Relay connects the conversations through an invited group.

> **Beta**
> Real Claude and Codex message delivery has been tested on Windows. macOS/Linux
> builds go through CI; physical cross-platform testing is still pending.

## Install

### One command: Windows, macOS, or Linux

Requires [Node.js 22.13 or newer](https://nodejs.org/en/download).

```sh
npx --yes @platys/relay setup
```

Paste your invitation, check your name, and connect. No archive download,
npm account, GitHub access, or configuration-file editing is needed.
Setup keeps its runtime outside the npm cache.

If you prefer a permanent CLI command:

```sh
npm install --global @platys/relay
relay setup
```

Version **0.8.0-alpha.12** includes the project-folder launcher fix. Windows PowerShell users
can use `npx.cmd`, `npm.cmd`, or `relay.cmd` if execution policy blocks the shims.

### Windows: no terminal needed

Download **RelaySetup-0.8.0-alpha.10-win32-x64.exe** from the
[beta release](https://github.com/vision-27/relay/releases/tag/v0.8.0-alpha.10).
Open it, paste a fresh invitation link, and click **Connect Relay**.
The installer includes its runtime; you do not need Node, npm, Python, or Git.
The beta installer is unsigned.

The repository and desktop releases are private. Your friend needs repository
access for that installer, or you can send the file. Public npm installation
above needs neither. The existing desktop download remains alpha.10.
For the project-folder launcher fix, update using the npm setup command above.

## Start talking

1. **Claude Code:** open the **Claude with Relay** desktop shortcut, choose your
   project folder, and accept Claude's folder/channel trust prompts. Start your task normally.
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
