# Relay reliability and UX verification

## Current release: 0.6.2 — 2026-09-16

Fixed a reproduced Windows HTTPS failure caused by an expired cached intermediate certificate. The client now uses trusted ROOT anchors with Python's secure TLS defaults and configured OpenSSL CA paths, retains hostname/certificate checks and refuses redirects. It does not alter the machine trust store; macOS/Linux retain the default TLS context. Corrected release/onboarding/recovery documentation and added commit-pinned, read-only cross-platform CI configuration (not yet run remotely).

- **192 tests run: 191 passed, one Windows directory-symlink fixture skipped**, 639.976 seconds, on the final runtime source.
- **44 browser checks passed** on an isolated hub with synthetic providers; mobile completion screenshot inspected.
- Focused TLS (6), recovery/polish (17), and release/documentation (4) tests passed and are included in the full run.
- Verified the patched client against the real shared HTTPS health and authenticated workspace APIs; no TLS bypass or certificate renewal.
- Built the 0.6.2 wheel and verified exact allowlisted source contents and both console entry points. Frontend syntax and workflow YAML passed.
- Quietly activated hub/Windows companion and published private Homebrew **0.6.2 revision 12**. Verified private tap clone, downloaded checksum and extracted CLI. No native Mac installation is claimed.
- SQLite backup: `.relay/hub/pre-062-20260916-225253.sqlite3`. Database integrity, member records, goal states and saved connection hashes preserved. No active team controller was interrupted; existing coding conversations/settings were untouched.

Source build: `81981d8e54b989d2def92ecd3f34cd2e00352ce66ea5cca5661890aa5dc0cbdf`. Archive SHA-256: `a6aef96d50bbedb93d531e9ea61ed9000bf787fba216cc323d3191bbce5b7720`. Evidence: `.relay/patch-062-verification.json` and `.relay/activation-062.json`.

Source publication destination is the private [vision-27/relay repository](https://github.com/vision-27/relay), confirmed 2026-09-17. Check its Actions page for remote CI results. Still outstanding: physical Mac upgrade/network/sleep-wake acceptance and real two-PC overlap/dependency checks. Automatic integration-controller crash takeover remains unsupported. The separate Codex-owned terminal-window issue is not patched by this release.

## Previous 0.6.1 activation and evidence

Activated on the shared hub and local Windows companion on 2026-09-16 after developer approval. Private Homebrew 0.6.1 revision 11 is published. Von's Mac upgrade and acceptance check remain pending.

## Changes driven by the two physical-PC trials

- Team inbox delivery is scoped to the enrolled goal, including join notices. Previously persisted unrelated deliveries remain in the audit history but do not appear in the team's inbox or block its guarded writes. Same-goal delivery/acknowledgement requirements and cross-goal file/contract reservations remain enforced.
- Live heartbeat, current assignment and concise goal status are returned together in one hub transaction. Client version reporting is cached and limited to once per minute instead of generating an archive and making another request every two seconds.
- Temporary hub/network errors block tools immediately and retry only connection checks, with a 2–15 second backoff. They do not create a new controller, steal reservations, replay a model turn, or retry an uncertain edit. Explicit pauses and authorization/controller errors still require developer action.
- Accepted delivery receipts can be retried independently of model input. A model input is never replayed merely because recording its delivery failed.
- The CLI prints authoritative hub completion progress. Completed goals do not wake models for join notices. Team instructions require fresh status before reporting after events or reconnection, and forbid guessing plan revisions after a stale-assignment rejection.
- Shell/install/join commands pasted into Relay are rejected instead of becoming requirements. Joining guidance explains that ordinary text changes the plan revision.
- The browser distinguishes completed work from agent connectivity, shows paused/offline workers with recovery guidance, removes joining from completed goals, and retains an obvious start-new-goal path. Existing design and conversation-sharing workflows are preserved.
- Package metadata matches the application version and exposes `relay-workspace` as well as the existing `relay` console entry point.

## Verification

- Initial broad run: 165 tests, 164 passed, one directory-symlink fixture skipped on Windows. Includes concurrency, overlap reservations, stale attempts, review authority, artifact hashes, timeouts/process-tree cleanup, installers and private Homebrew packaging.
- Final broad regression: 177 run, 176 passed, one skipped. Final focused regression suite: **14 passed**, including the later stale-heartbeat/sleep-wake check. It covers unrelated durable events, same-goal delivery gates, same/different-goal joins, atomic heartbeat/assignment retrieval, stale plan revision fencing, guarded outage handling, explicit-pause preservation, receipt-only retries, completed-goal idling, reporting throttles, and misplaced command detection. See QA.md for test-snapshot ordering.
- A real temporary HTTP hub injected a 503 outage. The running heartbeat loop closed file-tool access and reconnected the same controller without a provider offer or interruption; the same tool surface became available after recovery. This is an injected local HTTP fault, not a physical Mac sleep/wake test.
- Installed Codex and Claude, with an automatically launched Codex helper, completed a fresh temporary-hub trial: three disjoint tasks, independent plan review, guarded edits, peer artifact review, passing exact-content tests and local branch merges. Existing conversations and project checkouts were untouched. Evidence: `.relay/team-automation-native-verification.json`. This trial ran both providers on Windows; it is not a new physical-PC acceptance run.
- 44 browser checks passed for onboarding, consent, login persistence, sharing, retries, escaped content, tool-registration guidance, mobile layout, team completion and recovery. All model/transcript fixtures are synthetic; no production accounts are modified. Evidence: `.relay/companion-qa/verification.json`, `shared-goals-mobile.png`, `team-complete-mobile.png`.

Final source build: `a21c3db4f7dcc32bb7365185ee4a9319e04109e3c0300173fadf1056b38da391`. Local and shared HTTPS health and the Windows companion report this 0.6.1 build. Private tap clone, download checksum and extracted CLI checks passed; native Homebrew installation was not tested here. Archive SHA-256: `174b3617435dcca05c5e59be65d4cf4bccc8f5813384ce85e2b1f9d809e8a4b5`.

Activation backup: `.relay/hub/pre-061-20260916-221447.sqlite3`. SQLite integrity, member rows, goal states and saved connection hashes match the pre-activation snapshot. The companion is supervised, with its saved connection enabled and watching without a network error. Existing coding conversations and global agent settings were not changed. Evidence: `.relay/activation-061.json` and `.relay/homebrew-verification.json`.

## Still requires real-world acceptance

- Upgrade Von's Mac through Homebrew and launch fresh team sessions; repeat the Windows/Mac test on 0.6.1, including Tailscale interruption and Mac sleep/wake.
- Two real machines attempting overlapping feature edits and a multi-file dependency chain. Deterministic local tests cover reservation conflicts, but do not prove every real workflow.
- Automatic takeover after a controller process crash remains deliberately unsupported. Preserve the private run, reconcile branch/test state, and use explicit recovery; do not launch duplicate controllers.
- Connection recovery does not replay an interrupted model turn. If work stopped while offline, inspect `/status`, then use explicit `/pause` and `/resume` to reconcile the current assignment. Interrupted integration checks may require `/retry` after inspecting the retained candidate.
- Tests and setup commands still execute trusted repository code with the developer's OS permissions, not a security sandbox.
- The separate Codex app-owned terminal-window issue remains outside Relay's launch control. These changes do not patch Codex or wmux.

## Safe activation

1. Finish or explicitly pause current sessions; preserve any unintegrated work and reservations.
2. Back up the hub SQLite database using SQLite's backup API, not a blind copy of a live database.
3. Publish the 0.6.1 source archive to the existing private tap, then restart only the identified Relay hub/companion using hidden background launch options.
4. Verify local and shared HTTPS health/version, archive checksum, member records, and preserved connection configuration.
5. Have Von upgrade through Homebrew and start a fresh goal; old running clients do not acquire source fixes automatically.
