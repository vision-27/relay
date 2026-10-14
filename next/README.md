# Relay Next setup and acceptance

This guide covers the advanced repository connector and service operation.
For the current friend-to-friend setup, start with [Easy setup](EASY_SETUP.md).

Use the [shared room](SHARED_ROOM.md) to see connected agent sessions, follow
shared conversations live, and ask an agent a question from your browser.

For agents working at the same time in any workspace, use the
[hosted Relay MCP](REMOTE_MCP.md): add its URL and membership token to your client,
then discover peers and exchange questions through MCP. No Relay download is
required. The [local connector](NETWORK.md) is optional. The repository connection below
continues to support shared project context and code collaboration.

## Runtime and development

Node.js 22.13+ (tested with 22.20.0), Git, and your coding clients. Node 22 reports its SQLite API as experimental. No separate local database install is required.

```sh
npm ci
npm run check
npm test
npm run demo
```

Install the public CLI with `npm install -g @platys/relay`, or use `npx --yes @platys/relay setup`. Maintainers can also create a CLI archive with `npm pack`.

## Hosted service

Cloudflare is the selected adapter. See [the comparison](BACKEND_DECISION.md) for Convex, Supabase, Firebase and PocketBase. Free-plan quotas are hard limits, not free unlimited usage. Model usage remains with your coding client.

Deployment is an operator action, once for the team:

1. Sign into a Cloudflare account on Workers Free using `npx wrangler login`.
2. Generate a private random operator secret: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Run `npx wrangler secret put RELAY_CREATE_KEY --config next/worker/wrangler.jsonc` and paste the secret at its prompt.
4. Run `npm run worker:deploy`. This publishes the service and creates the SQLite Durable Object namespace. Record the HTTPS URL.
5. Set `RELAY_CREATE_KEY` in the owner's shell only while creating the project. Teammates join with expiring invitations and do not need the operator key.

Member tokens are independently revocable, stored hashed on the server, and scoped by each project's own database. Invitations expire after 24 hours and can be used once. The first version uses device membership rather than a separate email/OAuth account setup.

Each project gets one Durable Object. A busy project has one object's capacity and storage limits; additional projects distribute across objects. The alpha caps a project at 64 active sessions and 64 simultaneous connections. Archive/retention and operator abuse controls need further work before public signup; creation is operator-controlled.

## Connect

On the operator's checkout, when `.relay/cloudflare-deployment.json` and `.relay/cloudflare-secrets.json` were saved during deployment, use this shortcut. It reads the key locally and passes it only to the connection process:

```sh
npm run connect:hosted -- --provider codex
```

Add `--repo PATH` to connect a different Git repository. The shortcut installs hooks and starts the connector when you run it. Teammates use invitations and do not receive the operator key.

From the intended Git repository:

```sh
relay-next connect --server https://YOUR-RELAY.workers.dev --name Nalin --provider codex
relay-next invite
```

On the other computer, in a checkout of the same repository:

```sh
relay-next connect --invite INVITATION --name Teammate --provider claude
```

Git remotes establish shared identity, with SSH/HTTPS forms normalized. A repository without an origin can use `--repository SHARED_ID` deliberately on both machines. Credentials in remote URLs are not shared.

Config, native inbox credentials, SQLite and connector logs live in `.relay/next/`, excluded from Git. The installer merges project-local hooks and MCP config, backing up previous files in `.relay/next/config-backups/`. Global coding-client settings are not changed. Resume the session, then approve the client's hook/MCP trust prompts. No trust or permission bypass flags are installed.

New hooked sessions in this repository register automatically. Other repositories do not register through this project's hooks. Direct questions address a stable session ID, not a pane label.

Project owners can delegate device/member invitations to an admin. Run `relay-next members`, then `relay-next member-role --member MEMBER_ID --role admin`. Use `--role member` to remove admin permissions. Role changes are recorded in the project database. Admins can use the existing `relay-next invite` command and revoke ordinary members; only the owner can change roles or revoke admins. Invitations still enroll ordinary members. This grants no service-wide project creation permission or authority over another member's agent sessions. Existing clients can invite immediately after server-side promotion without reinstalling.

When cmux/wmux exposes a local control endpoint and exact pane identity, Relay adds an online/offline sidebar indicator. This is optional; terminal permissions are respected and no keystrokes or focus changes are used for delivery.

## Daily use

Ask the coding agent naturally. Tools: `relay_status`, `relay_context`, `relay_publish`, `relay_ask`, `relay_reply`, `relay_ack`. Questions return an ID immediately; answers arrive asynchronously. The installed instructions ask agents to publish significant intent and interface decisions.

```sh
relay-next status
relay-next status --json
relay-next context --session SESSION_ID --query authentication
relay-next ask --from YOUR_SESSION --to PEER_SESSION --message "What changed in authentication?"
relay-next doctor
relay-next stop
relay-next run
```

`stop` stops this repository's connector, not the coding agents. `run` resumes it in the foreground. Hooks retain local records while offline. Unknown native delivery outcomes remain available through context hooks; Relay does not repeat a possibly accepted prompt automatically.

Context arrives at lifecycle hooks and native model/tool boundaries. A running model request or tool cannot have already seen a newly arriving update. Code files are not mirrored. Git work continues normally; Relay reports whether the source commit is local and whether source work was uncommitted. Overlap warnings are advisory.

## Capture and evidence

- Agents record intent, rationale, contracts and tests with structured tools.
- At turn completion, a hook records bounded visible assistant text with a source label. Hidden reasoning and entire transcript files are not exported.
- Git state is attached when a record is created; offline replay retains that revision.
- Model-reported observations and tests are not independent implementation verification.
- Bounded full-text retrieval reports coverage and omitted candidate counts.
- Routine context does not start additional model turns. Directed questions/replies use native delivery.
- `accepted`: queue/socket accepted an offer. `delivered`: recipient acknowledged it. `answered`: addressed session replied.

## Local-only development

```sh
npm run relay -- dev --port 7337
```

From the same checkout in another terminal:

```sh
npm run relay -- connect --server http://127.0.0.1:7337 --provider codex
```

The local service binds to loopback and is not reachable from your friend's computer. Use a hosted HTTPS endpoint for that test. `npm run demo` runs an isolated fixture without enrolling real sessions.

## Cloudflare runtime verification

```sh
npm run worker:dev -- --local --port 8788 --var RELAY_CREATE_KEY:local-test
```

In another terminal:

```sh
npm run build
npm run test:worker
```

This tests storage, membership, idempotency, replay, notifications, answers and revocation in the Worker runtime. The `local-test` key is only for this local fixture; never deploy with it.

After an authorized deployment, the operator can check the actual hosted endpoint:

```sh
npm run test:hosted -- .relay/cloudflare-deployment.json .relay/cloudflare-secrets.json .relay/cloudflare-hosted-proof.json
```

This creates a new isolated fixture project, checks the HTTPS/WebSocket protocol and revocation, and retains two fixture events. It uses no model and does not modify existing projects. It is not a load test.

## Native and two-machine acceptance

Repository policy requires approval before model-credit tests. `npm run test:native` starts **one disposable Claude Code process**, in a temporary Git project, under the current login. It exposes only the fixture's Relay tools, enforces a US$0.50 provider budget cap and a 90-second wall deadline, and tests idle inbox → MCP acknowledgement → source reply. It never attaches to an existing human session. Provider-created test history may remain in the provider's normal storage.

Windows–Mac acceptance is separate:

1. Connect Codex in wmux and Claude in cmux to a disposable shared Git project.
2. Publish a changed authentication contract with reasons, paths and revision.
3. Verify the receiving agent sees it before changing affected code and correctly identifies whether the implementation is local.
4. Ask a question; verify source attribution and accepted/delivered/answered receipts.
5. Disconnect a machine, publish again, reconnect and verify replay without duplicate logical messages.
6. Restart during delivery; require an uncertain outcome rather than blind native retry.
7. Resume/compact and retrieve the decision again. Superseded records must stay superseded.
8. Change branch; older event provenance must remain unchanged.
9. A held provider permission prompt must remain held; peer messages grant no permissions.

Record exact clients, machines, timings and failures. Fixtures and a health endpoint do not establish production readiness.
