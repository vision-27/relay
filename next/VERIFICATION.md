# Relay Next verification

28 September 2026. Windows; Node 22.20.0.

## Verified locally

- TypeScript checks for Node and Cloudflare targets.
- 26 automated tests with real Git repositories, HTTP, SQLite, named pipes/sockets and MCP framing. Installer preservation/collision checks, foreground stop/resume, non-JSON HTTP error handling and exact-target cmux/wmux protocol fixtures are included.
- Two-connector demo: contract publication, directed question, acknowledgement and source-attributed answer.
- Actual Cloudflare local runtime: transactions, membership isolation, invitation join, duplicate protection, replay, WebSocket notifications through the hibernation API, answer receipts and socket closure after revocation.
- 425-event append/replay exercised; observed around 2–3 seconds on this workstation. This is not a hosted latency/scalability benchmark.
- 2,300-record local history fixture checks older retrieval and prevents superseded decisions from reviving after replay.
- Idle connector ticks avoid repeated remote requests; reconciliation does not rewrite unchanged sessions.
- CLI tarball installed into an isolated workspace prefix and its installed `relay-next --help` entry point executed successfully. Check the matching commit in GitHub Actions for remote CI results.

## Native integration evidence

- Codex 0.158.0: `queue --help` exposes existing-thread addressing.
- Claude Code 2.1.283: one real disposable Haiku session received a question through its native inbox and returned `RELAY_NATIVE_OK` through MCP from the exact addressed session. Its test transcript also confirms successful `relay_ack` and `relay_reply` calls for the same message and session.
- The first sandboxed attempt timed out without a model result. The approved retry with normal login/network access passed. Each attempt had a US$0.50 provider budget cap and 90-second deadline. The printed US$0.0031 was the first turn's reported cost, not a verified complete-run charge.
- Queue/socket success is accepted only. Recipient acknowledgements and replies are separate states.
- Model execution is opt-in. Native Codex queue delivery has not yet been exercised with a real receiving Codex session.

## Remaining acceptance

- Real Windows/macOS clients, active and idle delivery, compaction/resume and sleep/wake.
- Hosted latency, model context/token overhead, concurrent-project loads and retention/backup operations.

## Hosted deployment

- Deployed with user approval to [relay-context.nalin-offl02.workers.dev](https://relay-context.nalin-offl02.workers.dev/health). The user's dashboard showed the Free-tier 100,000 daily-request limit; no billing plan was changed.
- Active version after the operator secret was configured: `8c1e1826-cf4e-422d-a1db-acf9de78c45b` (28 September 2026).
- Hosted acceptance passed: HTTPS health, operator creation gate, repository identity, one-use invitations, authenticated WebSocket invalidation, idempotency/conflicting reuse, ordered replay, recipient ownership, source reply receipts, project isolation, revoked-token rejection and socket closure.
- That probe used two fixture members in a newly created isolated project. Two fixture events remain; no real agents or existing project data were used. This is functional hosted verification, not a load benchmark.
- Operator secrets and the detailed acceptance record are under the ignored local `.relay/` directory. Credentials are not included in this document or the CLI package.

No teammate's live session was modified during testing. Native Claude and hosted transport were verified separately; a real two-computer agent exchange remains an acceptance step.
