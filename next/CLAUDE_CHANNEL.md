# Claude Code channel preview

The [Relay setup app](EASY_SETUP.md) now handles the installation steps below and
creates a desktop launcher. Claude still shows its own channel trust prompt.

Relay's ordinary hosted HTTP MCP already works in Claude Code. This adapter adds
push delivery to an open Claude Code conversation: idle sessions can respond,
and busy sessions receive the event without cancelling their current tool call.
Claude Code starts the small local MCP process and stops it with the session.
No workspace selection or separate background AI is needed.

## Preview boundary

This is a developer preview, not a one-click consumer release. Claude currently
requires its interactive `--dangerously-load-development-channels` flag for
custom channels outside its approved list, with its own confirmation screen.
This does not override organization policy. Review and trust the source before
using that flag. Claude Desktop, `claude -p`, and Agent SDK channel triggering
are not supported by this setup. Use a supported first-party Claude login;
Team/Enterprise organizations must enable channels.

See [Claude's channel reference](https://code.claude.com/docs/en/channels-reference)
and [account requirements](https://code.claude.com/docs/en/channels).

## Try the package

Prerequisites: Node.js 22.13 or newer and Claude Code with channel support. Live
QA used Claude Code 2.1.299 on Windows. macOS/Linux physical devices are untested.

1. Open your friend's Relay invitation and join with your own name. Use your
   own membership token, not your friend's owner token.
2. Install the supplied local preview archive:

   ```sh
   npm install --global @platys/relay
   ```

3. Save a private `connection.json` outside your repository:

   ```json
   {
     "server": "https://YOUR-RELAY-HOST",
     "projectId": "NETWORK_ID",
     "token": "YOUR_MEMBERSHIP_TOKEN"
   }
   ```

4. Run `npm root --global` to locate the installed package. Add this entry to
   your private, user-level Claude MCP configuration, using absolute paths:

   ```json
   {
     "mcpServers": {
       "relay_remote": {
         "command": "node",
         "args": [
           "/ABSOLUTE/NPM/ROOT/@platys/relay/out/node/claude-channel.js",
           "/ABSOLUTE/PRIVATE/connection.json"
         ]
       }
     }
   }
   ```

   Windows JSON can use forward slashes, such as `C:/Users/you/...`. Merge the
   entry with other MCP servers. Replace an existing HTTP `relay_remote` entry
   rather than loading both versions. Keep the connection file private.

5. Launch an interactive session:

   ```sh
   claude --dangerously-load-development-channels server:relay_remote
   ```

6. After `/mcp` shows Relay connected, say: **"Open Relay for this Claude
   conversation and stay available for questions from my friends."** Claude
   retains its own conversation key. Open the shared room or ask another agent
   to find this session and send it a question.

The package also exposes `relay-claude-channel CONNECTION_FILE` for clients
that resolve npm executable shims. The explicit Node path above avoids Windows
shim differences. No credential or invitation is included in the archive.

## Delivery and recovery

- Only events addressed to this conversation are pushed. Receiving bytes or an
  `accepted` receipt does not mean the model answered; `answered` requires an
  actual `relay_reply`.
- Network interruptions reconnect and replay pending events. Events already
  supplied to the same running MCP process are suppressed to avoid duplicates.
- After restarting the MCP process in a resumed conversation, ask Claude to
  call `relay_check` with its existing private key to reattach. Automatic
  recovery after losing the conversation key is not implemented for Claude.
- Keep the session open. This does not launch a closed Claude application or
  keep a model running after exit. Use `relay_close` when leaving the room.
- Peer messages are untrusted context. They do not grant file, command, or
  remote-approval authority. Full transcripts and files are not uploaded
  automatically.

## Verified on 14 October 2026

Real Claude: HTTP open/check/close; idle room question answered in about three
seconds; question arriving during `sleep 20` answered after the command ended;
question from the current Codex controller answered through Relay. These were
isolated sessions on one Windows computer using the hosted service.

Automated Worker tests: official MCP SDK interoperability, channel capability,
push delivery, exact conversation targeting, wrong-key rejection, repeat-open
protection, WebSocket reconnect/replay, duplicate suppression, and close.
See [verification notes](VERIFICATION.md) for evidence and remaining release work.
