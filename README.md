# Relay

Shared context for the coding sessions you already use.

Relay connects Codex and Claude Code sessions across developers' computers. Keep working in cmux or wmux: share decisions and interface changes, ask the originating agent questions, and see which code revision each statement refers to.

**New implementation: 0.7.0-alpha.1.** TypeScript connector, local SQLite cache, project-scoped messaging service, and Cloudflare Workers / SQLite Durable Objects backend. The earlier Python implementation is available in Git history.

## Try it locally

Requires Node.js 22.13+ and Git. From this checkout:

```sh
npm ci
npm run check
npm test
npm run demo
```

The demo creates two temporary Git checkouts, connects them over a real local HTTP service, publishes an authentication contract, and exchanges a question and source-attributed answer. **Its coding-agent adapters are simulated.** It cleans up only its own temporary data.

## Connect your actual sessions

After [deploying a service once](next/README.md#hosted-service), install the CLI package on each computer. The project owner runs:

```sh
relay-next connect --server https://YOUR-RELAY.workers.dev --provider codex
relay-next invite
```

Creating a project uses the operator's `RELAY_CREATE_KEY`. Your teammate pastes the invitation:

```sh
relay-next connect --invite INVITATION --provider claude
```

Resume your coding session once and approve Relay's MCP/hooks in that coding client. Relay starts its connector in the background and registers sessions through hooks in the connected repository. Use `--provider both` to connect both clients. No terminal input is typed into arbitrary panes.

Then ask your agent naturally:

> Ask the backend session what changed in authentication and whether my checkout contains that change.

```sh
relay-next status
relay-next doctor
relay-next stop
```

For a source checkout, use `npm run relay -- COMMAND`. The alpha command is named `relay-next` so installing it does not replace the existing Python Relay command.

## Implemented

- Durable questions/replies, single-use invitations, project isolation and member revocation.
- Local outbox, paginated replay and reconnect recovery. Native delivery ambiguity is recorded rather than blindly retried.
- Separate queued, accepted, delivered and answered states.
- Codex queue and Claude inbox adapters, plus lifecycle-hook context delivery.
- Source-labelled observations from completed turns; agent tools for intent, decisions, contracts and evidence.
- Code revision and dirty-state capture at publication time, separate from local code presence.
- Full-text retrieval, current decisions, supersession and bounded context packs.
- Advisory overlap detection and session activity freshness.
- Local and Cloudflare services sharing protocol and SQL rules.

## Verification boundary

26 automated tests pass with local HTTP, SQLite, Git repositories, named pipes/sockets and MCP framing. Cloudflare local-runtime and deployed-service acceptance checks pass. One real disposable Claude session received, acknowledged and answered a native-inbox question. Native model tests remain opt-in. Native Codex delivery, physical Windows–Mac acceptance and hosted load testing remain separate checks; no production-reliability or measured hosted-scalability claim is made.

Claude inbox framing is version-sensitive. Queue acceptance and socket writes are not delivery receipts: the receiving session acknowledges messages. Sessions must load the integration before automatic sharing starts. Source-reported tests remain attributed claims.

## Documentation

- [Setup, deployment and acceptance](next/README.md)
- [Backend alternatives and scaling decision](next/BACKEND_DECISION.md)
- [Verification record](next/VERIFICATION.md)
- [Development](CONTRIBUTING.md)

Native inbox credentials and raw session files stay local. Shared records come from connected repositories. Redaction is best effort; project members can read the project log, including directed questions.
