# Automatic team coordination infrastructure

## 0.6.1: recovery and current state

Team inboxes are scoped to the enrolled goal. Heartbeat, assignment and concise hub status are refreshed together. Transient network failures close guards and retry connectivity without replaying model turns; explicit pauses remain paused. A fresh heartbeat is required after sleep/wake. See [release notes](CHANGELOG.md), [operations](docs/OPERATIONS.md) and the [physical acceptance checklist](RELIABILITY_ACCEPTANCE.md). The execution design below remains current; its original release was 0.6.0.

## 0.6.0: approved execution, integration and helpers

`relay-workspace team` now offers per-run automatic mode. The main agent and at most one helper on each PC use isolated Git worktrees; the existing developer checkout and conversations stay untouched. A helper is launched by the local controller only when queued tasks and busy workers make it useful. It receives the same goal-scoped tools and cannot spawn recursively. Independent review still requires a different developer. The goal owner enabling automatic integration raises the goal's implementation capacity to four.

The goal owner explicitly approves an exact test argument list and optional dependency-setup argument list. The controller, not the model, executes these commands in candidate worktrees, with a 120-second limit per command, bounded/redacted output, and owned process-tree cancellation. Windows uses a job object; POSIX uses a separate process group. Commands run with developer OS privileges, not in a sandbox. Approved setup may use the network; Relay never chooses or installs dependencies without this approval.

After artifact review, a transactional owner/controller-bound claim records the task attempt and goal revision. The controller checks artifact base/result hashes, commits only the supplied paths, runs setup/tests, rejects dirty or history-mutated test checkouts, and checks freshness and the unchanged integration head before merging. The merged tree must match the tested tree. A receipt must match approved commands, successful exit code, artifact hashes, task attempt, goal revision and dedicated branch before the hub marks completion. Receipts are evidence from a trusted developer controller, not remote execution attestation against a malicious owner.

Nonzero test exits return same-owner correction attempts, capped at three. Conflicts, setup failures, timeouts and uncertain state retain work and require inspection or explicit `/retry`. Dependencies are automatically materialized from completed peer artifacts into opted-in worker checkouts, with base-hash conflict checks and checkout-refresh fencing before the next task starts. No network Git fetch/push or automatic merge into the developer's current/default branch occurs. Final code is on the dedicated local `relay/goal-...` branch.

Pause/quit interrupt local helpers and owned tests, retaining reservations and candidate worktrees. Existing controller processes support `/resume`; cross-process restart/takeover of an interrupted integration is not implemented. A merge and remote receipt cannot be one atomic transaction: a disconnect or changed goal after local merge can leave a preserved commit requiring reconciliation, never an invented successful completion. Do not auto-rerun ambiguous work. Manual acceptance remains available after inspecting the integration checkout.

Native QA: real Codex, Claude and an automatically spawned Codex helper completed three disjoint outputs, independent reviews, controller tests and local Git merges. Evidence: `.relay/team-automation-native-verification.json`. This is separate temporary Windows checkouts, **not physical Mac/Windows acceptance**. See [GETTING_STARTED.md](GETTING_STARTED.md) and [UX_REVIEW.md](UX_REVIEW.md).

## 0.5.0 baseline (historical; superseded where noted above)

## What is automatic

- Opted-in new Codex/Claude sessions join a shared goal tied to project and Git repository identity.
- A deterministic scheduler elects a model-driven planner; the planner decomposes approved developer requests into a bounded dependency graph.
- A different developer's agent reviews scopes, shared contracts, duplication, dependencies and acceptance criteria before execution.
- Atomic transactions assign ready, non-overlapping tasks to available workers. Each worker has one implementation slot; a goal allows two concurrent implementation tasks.
- Every guarded write checks controller identity/freshness, task ownership, active goal and plan approval, path scope, Git base, current file hash, outstanding messages and conflicting reservations. Ordinary live-session reservations and team-task reservations block each other.
- Same-goal task questions use durable Relay delivery. Assignment notifications are deduplicated locally; uncertain model delivery is not blindly retried.
- Actual guarded-write file bytes and hashes are collected locally and submitted as bounded peer artifacts. Review reads these peer artifacts explicitly, not a possibly missing local file in another checkout.
- Independent result review accepts into `integration`, or returns corrections to the same worker with a new attempt number. Stale attempts are rejected. Three unsuccessful attempts stop for a developer decision.

## State and recovery

Task lifecycle: queued → assigned → working → review → integration → complete.
Corrections: review → assigned (next attempt); repeated failures or an explicit blocker retain ownership in blocked state.

The hub serializes scheduler mutations in SQLite immediate transactions. Assignments survive restarts. Offline or revoked workers never lose their unfinished implementation ownership automatically. Planning/review-only roles can move to another eligible live worker. Goal owners explicitly reconcile stopped work before `/recover`; this is not a Git operation.

Developer requirements are attributed to their author and increment the goal revision. That revision must be planned and peer-reviewed before more edits. Queued proposals may be revised; assigned tasks remain immutable. Planning/review can run at a safe turn boundary even when both workers hold unfinished tasks, avoiding a reservation/planning deadlock. Contradictory requests should pause for a developer choice; a new clarification can reopen planning.

## Completion is deliberately separate

Agents cannot call developer acceptance, recovery or enrollment through their managed tool surface. Peer review only produces `integration`. `/export TASK_ID` saves a private artifact JSON bundle without touching the checkout. The goal owner integrates and runs checks outside managed mode, then `/accept TASK_ID` checks local hashes and `/confirm TASK_ID <note>` records the developer's test/integration attestation. Hashes are rechecked at confirmation. This does not independently prove that reported tests ran. The final task acceptance completes the goal only when all tasks are complete and its latest requirements have been planned.

Dependency tasks wait for predecessor integration acceptance. Their artifact hashes must also exist locally before starting dependent work. No automatic cross-PC Git synchronization is supplied in this release.

## Authority and limits

This mode explicitly consents to task assignment and peer artifact sharing within one goal and confirmed repository. Arbitrary peer text cannot enroll another worker, change its goal, grant shell access or authorize another project. Existing sessions are not imported, resumed or retargeted. A matching client-reported repository key is not remote attestation of filesystem contents.

Source paths, secret-like files, symlinks/reparse points, hardlinks and protected agent directories retain the managed-file restrictions. Secret detection is best-effort. External editors and adversarial same-user filesystem races remain outside the guard boundary; a write already past its gate cannot be retroactively cancelled.

Limits: 32 tasks per goal, 16 tasks per proposal, 40 attributed requests, two concurrent implementation tasks per goal, one implementation slot per enrolled worker, 12 automatic assignment/message batches per controller per rolling hour, 60 managed tool calls per turn, five-minute turn limit, 120 KB artifact bundle. Limits are not monetary spending guarantees. No automatic helper-agent spawning or cross-PC reuse of existing subagents is implemented.

## Verification

Native Codex and Claude in separate temporary Windows checkouts autonomously planned and reviewed a two-task graph, received disjoint assignments, created the two exact-content files through guarded tools and reviewed each other's artifact bytes. Both stopped at integration pending developer verification. Evidence: `.relay/team-native-verification.json`. The first native run exposed a reviewer-local-file confusion; explicit peer artifact tooling and instructions resolved it in the rerun.

This is not a physical Windows/Mac acceptance run of team mode. Earlier two-PC message round-trip evidence remains valid only for live communication. Shared-goal dashboard browser QA uses fake data, including escaped script text and 390px mobile layout, not a live customer goal.
