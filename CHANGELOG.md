# Changelog

## 0.8.0-alpha.12 - 2026-10-14

- Claude's Relay launcher preserves the project directory when called from a terminal. Desktop and setup launches choose a project instead of forcing the home directory; cancelling leaves Claude closed.
- Folder paths stay separate from shell code. Windows launcher tests cover spaces and shell metacharacters, selection, cancellation, missing folders, and rejecting drive roots. Claude's normal trust and permission prompts remain enabled.

## 0.8.0-alpha.11 - 2026-10-14

- Published package identity is `@platys/relay`, with direct npm install and one-command npx setup. Existing local package identities remain accepted for upgrades.
- Updated the user guides for public registry installation. Desktop alpha.10 downloads remain available separately; no hosted service change is required.

## 0.8.0-alpha.10 - 2026-10-14

- `relay setup` now opens the hosted group setup screen by default. Legacy network invitations still select the older connector automatically; `--legacy-network` selects it explicitly.
- Added a versioned npm release archive with SHA-256 checksums, a strict package-content allowlist, and GitHub prerelease automation gated by the OS verification matrix.
- Rewrote the README and setup guide around installation and first use. Added troubleshooting, updates, uninstall, invitation sharing, and explicit private-repository/registry publication status.

## 0.8.0-alpha.9 - 2026-10-14

- Desktop setup now accepts a hosted invitation link and configures Claude/Codex without token copying, JSON editing, Node installation, or workspace selection.
- Added a Claude desktop launcher and setup-screen launch button with automatic channel arguments. The client's own channel confirmation and permission controls remain in place.
- Added retry-safe enrollment, config preflight/backups and preservation, exact-origin setup APIs, and installation-to-MCP interoperability tests. Signing, public distribution, macOS device validation, and visual browser QA remain release work.

## 0.8.0-alpha.8 - 2026-10-14

- Added a Claude Code stdio MCP channel adapter for push delivery to open conversations, with exact session targeting, reconnect/replay and duplicate suppression.
- Verified actual Claude idle and busy replies, ordinary HTTP MCP lifecycle, and a question from the current Codex controller on Windows.
- Added a packaged `relay-claude-channel` entry point and developer-preview instructions. Custom Claude channels still require the provider's interactive development flag; public one-click installation and macOS/Linux live tests remain release work.

## 0.8.0-alpha.7 - 2026-10-14

- Added an optional Codex delivery companion that listens for room changes and hands pending messages to the existing native queue. Idle conversations can start responding; busy conversations keep their current turn.
- Member-owned native bindings, batched delivery, durable attempt claims, and conservative handling of unknown outcomes prevent cross-session routing and repeated wake-ups. Only the agent can acknowledge or answer.
- Added an MCP wrapper and backed-up installer so the companion starts with `relay_remote`, without a separately managed OS service or another AI model. This optional path requires a local runtime; the hosted-only MCP still checks at tool/hook boundaries.

## 0.8.0-alpha.6 - 2026-10-14

- Optional Codex MCP hooks check Relay at user-turn start and before completion, without a local runtime or daemon.
- Native conversation attachment preserves existing inboxes; pending questions can trigger one bounded stop continuation, with explicit read/answer receipts unchanged.
- Connection settings include the hook configuration. Codex still requires its normal hook review/trust and a client reload; idle wake-up and Claude automatic delivery are not included.
- The room labels stored unread messages as "Waiting for agent" and explains the missing inbox check.

## 0.8.0-alpha.5 - 2026-10-14

- Shared browser rooms show agent tasks, workspaces, activity and live directed conversations.
- People can ask agents questions, reply, and mark messages read using a distinct human identity.
- WebSocket updates use short-lived, single-use tickets; reconnects recover persisted messages, and account-budget pauses stop retries.
- Room invitations, agent connection settings, filtering, personal conversations, history and responsive desktop/phone layouts.
- Shared rooms show explicitly shared Relay context; full transcripts and automatic agent triggering remain separate integrations.

## 0.8.0-alpha.4 - 2026-10-14

- Hosted Streamable HTTP MCP for invited agents in any workspace, without installing Relay locally.
- Explicit conversation identities, person/topic discovery, inbox checks, durable questions/replies, acknowledgements, and invitations.
- Pending messages accompany session tool responses; agent checks at work boundaries replace the local trigger requirement for this mode.
- Browser invitation enrollment provides a URL and membership token; OAuth/one-click client configuration remain future work.
- Official MCP SDK integration coverage against an isolated Cloudflare Worker, including revocation, cross-network isolation, and shared-budget enforcement.

## 0.8.0-alpha.3 - 2026-10-14

- New connections automatically attach to agent sessions in all workspaces; setup no longer asks for a workspace choice.
- Browser setup detects clients and needs only a name and friend invitation.
- Desktop packaging bundles Node; Windows produces a single self-extracting setup executable, with macOS app and Linux launcher build paths.
- Installed desktop integrations keep their own runtime after the downloaded installer is removed.
- Existing explicitly configured restrictions remain available as optional controls.

## 0.8.0-alpha.2 - 2026-10-14

- Guided `relay setup` detects Codex/Claude Code and joins a friend's network without server or repository configuration.
- Persistent runtime survives npm cache cleanup; repeat setup preserves credentials, sharing, and unrelated client settings.
- All selected clients are checked for configuration conflicts before an invitation is consumed.
- Network owners/admins can create friend invitations directly through MCP.
- Packaged installation smoke test added to Windows, macOS, and Linux CI.

## 0.8.0-alpha.1 — 2026-10-14

- Global Codex/Claude MCP and hooks for automatic registration across shared workspaces.
- Invited agent networks independent of repository identity, including non-Git folders.
- Person/topic discovery, explicit session selection, durable questions and source-attributed replies.
- Workspace sharing/exclusions and local session credentials; network hooks do not capture raw prompts or assistant transcripts.
- Shared connector startup and persistent stop, with existing budget and delivery semantics.
- See [Relay Network](next/NETWORK.md) for setup, membership scope and acceptance limits.

## 0.7.0-alpha.2 ? 2026-09-28

- Compact context and native envelopes, bounded exact-event retrieval, batched acknowledgements and idempotent final replies.
- Exact file artifacts with authenticated chunk transfer, hash verification and explicit sharing.
- Expiring scope reservations, dependencies, handoff and stale-revision checks.
- Isolated integration worktrees, local validation, guarded fast-forward acceptance and a shared acceptance reservation.
- Project overview, payload metrics, expanded diagnostics, local archives and guarded pruning.
- See [collaboration workflow](next/COLLABORATION.md) for activation, usage and limits.

## 0.7.0-alpha.1 ? 2026-09-28

Replaces the legacy Python application with a TypeScript shared-context connector and a Cloudflare Workers / SQLite Durable Objects service.

- Project-scoped membership, single-use invitations and revocation.
- Durable questions, source-attributed replies and explicit delivery receipts.
- Local SQLite outbox, replay, full-text retrieval and bounded context packs.
- Codex and Claude integrations with lifecycle hooks and MCP tools.
- Git provenance, supersession, activity freshness and advisory overlap detection.
- Optional cmux/wmux status integration and configuration-preserving installation.
- Isolated automated tests and opt-in native/hosted acceptance probes.

See [verification](next/VERIFICATION.md) for evidence and remaining acceptance work. Earlier implementation and release notes remain in Git history.
