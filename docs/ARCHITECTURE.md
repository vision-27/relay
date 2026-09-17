# Architecture

Relay separates shared knowledge and coordination from local execution. The hub stores goals and evidence; each developer controls the agents and credentials running on their own machine.

```text
Developer A: CLI + managed agent + optional helper + isolated worktrees
                         ↕ authenticated requests
                Hub: SQLite, coordination, browser state
                         ↕ authenticated requests
Developer B: CLI + managed agent + optional helper + isolated worktrees
```

## A team goal's lifecycle

1. A developer creates a goal and approves execution settings. Another developer joins the same goal.
2. Relay assigns planning and requires an independent developer's agent to review the task graph.
3. Ready tasks are assigned to workers. Reservations, revision checks, current context and file hashes guard writes.
4. Workers submit artifacts; independent peers inspect the actual bytes and request corrections or accept them.
5. The goal owner's approved controller assembles a candidate, runs configured checks and integrates the tested tree into a dedicated branch.
6. The hub accepts a matching receipt before marking a task complete. The developer decides when to publish or merge that branch.

Review is bound to revisions and attempts. A stale review cannot approve a changed plan. Disconnected workers retain ownership; reconnection does not authorize takeover. A helper can implement work but cannot replace the second developer's independent approval.

## Code map

| Module | Responsibility |
| --- | --- |
| `relay/server.py`, `store.py` | HTTP/authentication and SQLite persistence |
| `relay/team.py`, `team_tools.py` | Goals, planning, assignments, reviews, task artifacts and scoped agent tools |
| `relay/live_coordination.py`, `coordination.py` | Delivery receipts, acknowledgement, reservations and work gates |
| `relay/managed_live.py`, `managed_providers.py` | Owned agent lifecycle, heartbeat, event delivery and provider protocols |
| `relay/managed_tools.py` | Restricted file access, fresh hashes, path protection and guarded writes |
| `relay/automation.py`, `team_integration.py` | Helpers, worktrees, approved tests, candidate checks and integration receipts |
| `relay/companion.py`, `web/` | Local browser application and shared workspace views |
| `relay/adapters.py`, `worker.py`, `mcp.py` | Selected-conversation observation, explanations and advisory tools |
| `relay/lifecycle.py`, `processes.py` | Background supervision and platform-specific process handling |
| `relay/distribution.py`, `homebrew.py`, `install_client.py` | Source-only packaging and private installation |

## Three different kinds of evidence

- **Conversation context:** agent-derived summaries with provenance, not approval to edit.
- **Coordination records:** a particular session's plan, message, review or reservation, not proof a test ran.
- **Integration receipt:** an approved controller's test/merge result for specific artifacts, revisions and commands; not an independent security attestation.

The browser's hub status can be newer than agent prose. Use task IDs and session IDs when checking a trial; member display names are not unique agent identities.

## Persistence and availability

The hub database, tokens and per-user run records are private operational data, not source artifacts. Temporary outages close file-tool gates and retry connectivity. Explicit pauses remain paused. Interrupted model turns are not replayed, and process-crash integration takeover is not automatic. See [operations](OPERATIONS.md) and [security](../SECURITY.md).

On Windows, 0.6.2 builds its HTTPS context from trusted ROOT anchors rather than the cached intermediate CA store, preventing an expired cached cross-sign from shadowing a valid server chain. It retains Python's secure defaults and configured OpenSSL CA paths; it does not change Windows trust settings. macOS/Linux use the standard context. API redirects remain disabled. See Python's [certificate-store and context documentation](https://docs.python.org/3/library/ssl.html#ssl.enum_certificates).
