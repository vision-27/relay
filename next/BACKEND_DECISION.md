# Hosted backend decision

Researched 28 September 2026. These are documented capabilities and design estimates, not a comparative production benchmark.

## Workload

Relay needs small, durable project event logs, authenticated membership, ordered reconnect replay, targeted message receipts and notification fanout. Agent execution and local Git inspection remain on each developer's machine. Context correctness depends on evidence, source revisions and acknowledgement semantics, regardless of database vendor.

| Option | Fit | Cost and scaling tradeoff | Decision |
| --- | --- | --- | --- |
| Cloudflare Workers + SQLite Durable Objects | One room owns each project's log and active sockets. Transactions serialize room updates; hibernation preserves idle WebSockets. | Free DO quota: 100k requests/day, 5M rows read/day, 100k rows written/day, 5 GB total storage. Per-object free storage limit is 1 GB. Worker limits also apply. Independent projects distribute across objects; a hot single project remains bounded by one object. | Selected for the first hosted adapter. |
| Convex | Reactive queries, mutations, auth options and strong TypeScript support reduce application plumbing. | Free: 0.5 GB DB, 1 GB/month DB I/O, 1M function calls/month; subscription updates count. S16 performance class. Easier application development, less direct control of reconnect and event fanout costs. | Strong runner-up if a broader application/dashboard becomes the primary workload. |
| Supabase | Postgres transactions, Auth and Realtime; excellent relational/reporting flexibility. | Free projects can pause after low activity over seven days. Durable message log and native-agent delivery still need implementation. | Useful later for broader relational reporting; not required for the two-person connector. |
| Firebase / Firestore | Managed document database and live subscriptions. | Free quota: 1 GiB, 50k reads/day, 20k writes/day. Listener changes and reconnects can consume document reads; data model and security rules require provider-specific work. | Viable, without a decisive advantage for this SQL event-log design. |
| PocketBase | Compact SQLite backend with auth and subscriptions. | Software is free, but hosting, TLS, backups and availability are the operator's responsibility. Docs caution about pre-1.0 compatibility and production-critical use. | Good self-hosted alternative; adds operations to the setup experience. |

## Efficiency choices in this implementation

- Persist first, then send small invalidation notifications. Clients replay only events after their durable cursor, in pages of 200.
- WebSocket notifications drive remote reads; bounded periodic reconciliation handles missed signals. Local hook polling is separate from network polling.
- No LLM runs for transport, heartbeat, acknowledgements or Git state. Structured decisions are published by the coding agent. Automatic observations retain their observed source label.
- Local SQLite stores an outbox and delivery attempts across restarts. Native-provider timeout ambiguity never triggers blind replay.
- One object/database per project. SQL and protocol logic are shared with the local Node backend, making the portable portion testable without a vendor account.
- Runtime inputs, event sizes, project sessions and connections are bounded. This alpha targets small project teams, not an unmeasured enterprise concurrency claim.

## What must be measured before broader rollout

Two real machines: source event to recipient context latency (p50/p95), reconnect recovery, hook overhead, model-token overhead, false context claims, wrong-version assumptions and lost/duplicate logical messages. Load tests must include growing logs and multiple projects. Provider receipt acceptance is not evidence of model understanding.

## Sources

- [Cloudflare DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Convex limits](https://docs.convex.dev/production/state/limits)
- [Supabase free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Firestore pricing](https://firebase.google.com/docs/firestore/pricing)
- [PocketBase documentation](https://pocketbase.io/docs/)
