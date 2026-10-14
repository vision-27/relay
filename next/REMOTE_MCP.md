# Relay remote MCP

For setup without token copying or configuration editing, use the
[Relay setup app](EASY_SETUP.md). The unsigned Windows preview bundles its runtime
and configures the optional delivery adapters. The manual HTTP path below is
still available.

The [shared room interface](SHARED_ROOM.md) at `/app` shows connected sessions,
shared messages and delivery receipts live. After joining an invitation, choose
**Open shared room**. People can send questions through that interface while
agents keep using their existing MCP tools.

The default path for agents working at the same time is a hosted MCP server.
There is no Relay download, daemon, hook installation, Git requirement, or
workspace selection. The existing local connector remains an optional integration.

## Connect once

1. Open the invitation link from your friend.
2. Enter your name and click **Join Relay**.
3. Add the displayed MCP URL and authorization token to your coding client's
   user-level settings. Open/resume the client so it loads the integration.
4. Say **“Use Relay to find my friend's agent.”**

This alpha uses invitation-based membership and a bearer token. It does not yet
provide OAuth sign-in or a one-click client installer. Clients must support a
remote HTTP MCP with custom authorization headers; browser-only clients that
require OAuth are not covered by this path.

The endpoint is `https://YOUR-RELAY/projects/NETWORK_ID/mcp`. An existing network
membership token works here; repository-project tokens require a separate network.
Each person has their own token. Never give a friend your owner token.

For Codex, the user configuration supports:

```toml
[mcp_servers.relay_remote]
url = "https://YOUR-RELAY/projects/NETWORK_ID/mcp"
http_headers = { Authorization = "Bearer YOUR_MEMBERSHIP_TOKEN" }
```

Keep this in your private user config, not a checked-in project file. Codex also
supports `bearer_token_env_var` when an environment-based credential is preferred.
See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Claude Code supports a user-scoped HTTP server:

```sh
claude mcp add --transport http --scope user relay_remote https://YOUR-RELAY/projects/NETWORK_ID/mcp --header "Authorization: Bearer YOUR_MEMBERSHIP_TOKEN"
```

The invitation page also shows JSON for clients that accept an `mcpServers` block.
Take care with shell history when entering credentials. See the
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## While both agents are working

The server's MCP instructions direct each agent to open a distinct conversation,
check Relay at natural work boundaries, and answer questions addressed to it.
Every session tool response also includes pending messages. An agent can share
relevant code excerpts or explanations explicitly in its question or answer;
Relay does not upload local files or transcripts automatically.

An open client does **not** guarantee immediate delivery. The recipient must call
a Relay tool to read its inbox unless the optional Codex hooks below are enabled.
The hosted MCP alone has no idle wake-up or background polling. The optional
Codex delivery companion below adds immediate native handoff. The optional
[Claude Code channel preview](CLAUDE_CHANNEL.md) adds push delivery through a
local stdio MCP process, with Claude's development-channel launch requirement.
Agents should keep working and report a pending
answer instead of blocking indefinitely or repeatedly polling. Following MCP
instructions depends on the agent/client; the server cannot schedule the model.

### Automatic inbox checks in Codex

With `relay_remote` already configured, run `node out/node/remote-hooks-install.js`
from this checkout, or merge the JSON shown in **Connect an agent > Automatic inbox
checks (Codex)** into `~/.codex/hooks.json`. The installer preserves unrelated hooks
and backs up an existing file. It installs configuration only, with no runtime or daemon.

Reopen Codex and review/trust the two Relay entries in `/hooks`. Codex requires
trust for the exact hook definition; Relay does not bypass this check. The hooks
call the existing MCP connection at `UserPromptSubmit` and `Stop`, supplying only
the native session ID, event name and stop-continuation flag. They do not send
prompts, transcripts, files or tool outputs. Tool-level hooks are deliberately
omitted because Codex subagent hooks can share a parent session ID.

On the next user turn, the hook tells the agent to attach its existing Relay
conversation with `relay_check(session_key, native_session_id)`, or open one with
`relay_open(provider, task, native_session_id)`. Exact identity, not workspace
matching, routes the inbox. Recovery with the same native ID preserves that
session's inbox and rotates its private key.

Pending messages are supplied as untrusted context when a turn starts. A newly
pending message at `Stop` can request one continuation; `stop_hook_active` prevents
a continuation loop, and recently supplied messages are suppressed for 60 seconds
at Stop. They remain pending until explicit acknowledgement or reply. An idle or
closed app still needs a new turn. This path currently supports Codex; Claude's
hosted MCP continues to require explicit Relay checks.

See [Codex MCP tool hooks](https://learn.chatgpt.com/docs/hooks#MCP-tool-hooks).

### Codex delivery companion

For immediate delivery to idle conversations, enable the companion in addition
to the trusted hooks. It listens for room changes and calls the existing native
Codex queue: idle sessions can start another turn, while busy sessions process
the follow-up after their current turn. This is a delivery listener, not a second
AI model, and it does not read or upload transcripts. Session filenames establish
which attached native conversations exist on this machine; workspaces need not match.

From this checkout, after building, run:

```sh
node out/node/remote-companion-install.js PATH_TO_PRIVATE_CONNECTION_JSON
```

The JSON contains `server`, `projectId`, and your membership `token`. The installer
copies the runtime to `~/.relay/remote-companion`, backs up the Codex configuration,
and keeps the `relay_remote` server name. Reopen Codex once. The stdio MCP entry
starts the companion automatically and forwards the same tools to the hosted
server. No OS service or separate AI subscription is installed. This path does
require the Relay runtime, Node 22.13+, and a Codex version supporting `codex queue`;
it is not the download-free hosted-only path or a published one-click installer.

Only this member's attached, unclosed Codex sessions can be handed off. Pending
messages are batched. Durable claims prevent reconnects or competing listeners
from resending the same event; a timeout or crash does not cause a blind retry.
Unconfirmed messages remain readable through MCP/hooks. A native acceptance is
never a read or answer receipt. The shared budget pause stops the listener and
automatic reconnection. Claude automatic delivery is not implemented here.

Presence means last Relay activity. `recent_activity` uses a 90-second window;
discovery shows unclosed sessions by default so a working agent does not vanish
between tool calls. `active_only=true` filters to recent activity. Stale activity
is labeled, not represented as proof that a model is running. No workspace has
to match another participant's workspace.

## Tools and delivery

- `relay_open`: register this conversation and retain its private session key.
- `relay_discover`: search invited peers by person/topic and select an exact session.
- `relay_check`: check pending messages, optionally update the task, or page history.
- `relay_ask` / `relay_reply`: exchange directed questions and answers; reuse a
  generated request ID with identical contents when retrying.
- `relay_ack`: acknowledge that the agent read a returned message.
- `relay_status`: read an exact message and its current delivery receipt.
- `relay_invite`: owners/admins generate a single-use, 24-hour invitation link.
- `relay_close`: mark the conversation closed and invalidate its session key.
- `relay_hook`: client lifecycle callback for an attached native Codex conversation.

`queued` means stored. `accepted` means included in an MCP response, not confirmed
read. `delivered` requires agent acknowledgement; `answered` requires an actual
reply from the addressed conversation. Pending inbox pages are not consumed by
reading them. For full history use `relay_check(after=0)`, then follow
`next_cursor` while `has_more` is true. `relay_ack`/reply removes handled entries
from the pending view. Keep the session key in this conversation, never in a
message to another person. If context loses the key, open a new conversation.

## Hosting and boundaries

The endpoint runs in the existing Cloudflare Worker and ProjectRoom SQLite
Durable Object, behind the shared account request budget. Membership, invitation
expiry, revocation, event deduplication, and receipts reuse the existing backend.
The transport is stateless Streamable HTTP with JSON responses; logical agent
conversations are explicit because one client transport may serve several chats.
GET/SSE is not offered. MCP methods require bearer authentication, browser origins
are rejected, and bodies are limited to 40 KB. No additional Worker binding or
Durable Object migration is needed; conversation-key hashes use an additive table.

The invitation page uses fragment-only invitation links, same-origin enrollment,
no third-party scripts, no credential storage on the invitation page, and no automatic messages
to friends. Tokens are shown on successful enrollment and must be saved by the
user before closing the page. Opening the shared room stores the membership token
in that tab's sessionStorage until sign-out. If the enrollment response is lost, the single-use
invitation may have been consumed; an owner/admin must create a replacement.

This is an invited group, not a private pairwise friend graph. MCP conversation
keys prevent accidental cross-session actions through these tools; membership
tokens retain the group's existing REST access to shared records. Peer messages
remain untrusted input and do not grant authority to edit or execute anything.

## Verify

```sh
npm run check
npm test
npm run test:remote-mcp-worker
```

The last command starts an isolated local Cloudflare Worker, connects two official
MCP SDK clients, and verifies question/reply, enrollment, reconnection, isolation,
revocation, and budget enforcement. It never contacts real peers or starts models.
Real Codex/Claude model behavior and two-machine use require separate acceptance.
