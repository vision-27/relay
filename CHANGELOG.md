# Release notes

## 0.6.2 — 2026-09-16

- Fix Windows Python TLS chain selection by loading server-authentication roots from the Windows ROOT store, not cached intermediate certificates from its CA store. An expired cached ISRG cross-sign previously masked the valid shared-hub chain. Hostname and certificate verification remain mandatory; no machine trust settings are changed. macOS/Linux retain Python's default context.
- Reuse the verified HTTPS context per client and report certificate failures distinctly from ordinary network outages. Redirects still cannot forward credentials.
- Add regressions for repeated reconnects, stale guards before controller ticks, pause during outage, TLS trust selection, release metadata, documentation links and source-only archives.
- Refresh onboarding, recovery, architecture, security and release documentation. Prepare a read-only, commit-pinned Windows/macOS/Linux CI matrix.

Read-only reproduction: the old Windows Python path failed with certificate-expired verification; the corrected client verified the same private HTTPS hub successfully. The leaf certificate was valid through December 2026. No renewal or TLS bypass was needed. Physical Mac sleep/wake and remote CI remain separate checks.

Verification: **192 regression tests run, 191 passed, one Windows symlink fixture skipped**; **44 browser checks passed**. The wheel built successfully with only allowlisted application source. The shared hub and Windows companion are activated on 0.6.2; private Homebrew revision **12** is published. Verified HTTPS authentication, private tap clone, downloaded archive checksum, extracted CLI and preserved workspace records all passed. Source and tagged releases are maintained in the private [vision-27/relay repository](https://github.com/vision-27/relay); remote CI results are recorded separately in Actions.

Source build: `81981d8e54b989d2def92ecd3f34cd2e00352ce66ea5cca5661890aa5dc0cbdf`. Private archive SHA-256: `a6aef96d50bbedb93d531e9ea61ed9000bf787fba216cc323d3191bbce5b7720`. Existing coding conversations and system trust settings were not changed.

## 0.6.1 — 2026-09-16

Reliability and usability follow-up from two physical Windows–Mac trials.

- Scope team event delivery to the enrolled goal; unrelated historical events no longer gate new-goal edits. Preserve their audit history and cross-goal reservations.
- Refresh heartbeat, assignment and hub progress together. Throttle optional version reporting.
- Retry transient hub connectivity with bounded backoff while blocking tools. Reconnect the same controller without replaying model input or bypassing explicit pause.
- Require a fresh heartbeat after sleep/wake before team operations. Retry accepted delivery receipts separately from model turns.
- Print authoritative completion progress and avoid waking completed-goal agents for join notices.
- Reject misplaced shell commands instead of turning them into goal requirements.
- Clarify browser completion, paused/offline recovery and starting another goal.
- Align package metadata and both `relay-workspace` / `relay` entry points with 0.6.1.

Private distribution: Homebrew version **0.6.1**, formula revision **11**. Source build: `a21c3db4f7dcc32bb7365185ee4a9319e04109e3c0300173fadf1056b38da391`. Archive SHA-256: `174b3617435dcca05c5e59be65d4cf4bccc8f5813384ce85e2b1f9d809e8a4b5`.

The hub and Windows companion were activated after approval and a SQLite backup. Member records, goal states and saved connection configuration were preserved. Von's Mac upgrade and physical sleep/wake acceptance are not yet verified. See [QA scope and results](POLISH_QA.md).

Documentation and CI preparation after activation do not change the packaged runtime or these release hashes. GitHub publication is separate from publication to the private Homebrew tap.

## 0.6.0 — 2026-09-14

Added opt-in isolated worktrees, one helper per computer/run, approved setup and tests, dependency artifact transfer, bounded corrections, and receipt-checked integration into a dedicated local branch. No automatic push or merge into the developer's current branch. Two subsequent physical Windows–Mac trials completed with three independently reviewed artifacts each.

## Earlier releases

- **0.5.0:** shared goals, automatic planning/assignment, independent review and cross-checkout artifacts.
- **0.4.x:** newly launched managed working sessions, live peer messages and guarded file edits.
- **0.3.x and earlier:** selected-conversation sharing, owner-context questions, local companion, private installation and connection checks.

Detailed historical evidence is retained in [QA.md](QA.md) and [LIVE_COORDINATION.md](LIVE_COORDINATION.md). Historical limitations describe their release, not necessarily the latest team mode.
