# Shared monthly Relay request budget

The hosted service uses one AccountBudget Durable Object across every Relay project
and device. Its normal monthly allowance is 9,500,000 incoming Worker requests.
The billing anchor is supplied during one-time operator initialization. For this
deployment the renewal day is the 6th, based on the owner's subscription date.
The configured boundary is 00:00 UTC on the 6th; the subscription's exact activation
time was unavailable. The first period was conservatively seeded with 840,000
requests, covering 824,899 observed account requests since September 28 plus margin.
Initial usage must include earlier traffic; never initialize historical usage to
zero without evidence. Account analytics reconciliation only increases the counter.

The threshold latches a durable pause and records an alert with a pause ID. Project
operations stop, connected clients receive a WebSocket alert, and updated clients
persist the pause locally. Normal HTTP retries and WebSocket reconnections then
make no network requests. Queued work remains on disk. Neither restarting clients
nor crossing the monthly boundary clears a threshold pause.

The old 250,000-request local cap is no longer used. Its historical ledger is
retained, but the shared service owns the budget.

## Owner monitor and alert

The owner runs out/node/budget-operator.js watch with the local configuration in
.relay/budget-operator.json. Every minute it reads shared status and Cloudflare
account request analytics. It writes .relay/budget-operator-state.json and logs
errors. On a pause it records the alert in ~/.relay/budget-alerts.log, disables the
Worker's workers.dev and preview endpoints through Cloudflare's control plane,
verifies that change, and sets workers_dev=false in the Wrangler configuration.
It stops polling the disabled Worker. No model or email service is used.
On the owner's Windows machine, the RelaySharedRequestBudget scheduled task starts
the hidden monitor at login. Its logs are .relay/budget-monitor.log and
.relay/budget-monitor-error.log. The monitor is not a hosted always-on service.

The owner monitor needs this computer online and a valid Cloudflare login.
The shared server pause remains enforced independently, but endpoint shutdown is
not guaranteed while the owner monitor is unavailable. Analytics can be delayed
or sampled; this is not an exact Cloudflare invoice meter. Rejected requests
still invoke a publicly reachable Worker, which is why endpoint shutdown matters.
The 500,000-request margin accommodates ordinary detection/propagation delay;
it is not a mathematical guarantee against arbitrary traffic bursts.

This protects Worker requests for Relay. Durable Object requests/duration,
storage and CPU have separate included allowances and can generate other charges.
Other account Workers appear in analytics but are not disabled by this monitor.

## Inspect and resume

Local cached client status (no network):
    node out/node/cli.js budget

Owner monitor status (no network):
    node out/node/budget-operator.js status

Only after the user explicitly approves:
    node out/node/budget-operator.js resume --approve --extra-requests N --reason "User approval reference"

Within an exhausted period, N must be an explicitly approved positive allowance
large enough to exceed the current counter. It is never inferred automatically.
In a new billing period, N can be zero. Approval is authenticated using the
operator key, tied to the exact pause ID, idempotent and audited. Cloudflare login
credentials stay on the owner's computer and are never shipped to peer clients.
Only a confirmed approved response can clear clients' persisted pause.

After owner approval, peers explicitly refresh and reconnect:
    relay-next budget-refresh
    relay-next connect --no-install

The service gates older clients too, but they will not stop retrying until upgraded
or the public endpoint is disabled. Deploying the Worker is not a client upgrade.

## Validation

Node tests cover aggregation, cutoff, rollover, short months, stale responses,
persistent client pauses, approval authorization/idempotency and owner shutdown.
The isolated Cloudflare budget smoke test covers simultaneous requests across
projects, WebSocket alerts and approved resumption. Never run exhaustion tests
against the production service.
