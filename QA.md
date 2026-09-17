# Relay usability and functional QA — 2026-09-13

## 0.6.2 Windows HTTPS patch — 2026-09-16

Reproduced Python's certificate-expired failure on the shared HTTPS hub while Windows' native TLS stack accepted the valid chain. Windows' Python default trust load included an expired ISRG Root X2 cross-sign from the intermediate CA cache. Loading trusted ROOT anchors (with normal secure context defaults and OpenSSL CA paths) verified the same endpoint and authenticated workspace API without any certificate bypass or system trust-store change.

Focused checks: 6 TLS tests passed; 17 recovery/polish tests passed, including three added outage/pause/stale-guard cases; 4 documentation/release checks passed. Final full regression: **192 run, 191 passed, one Windows directory-symlink fixture skipped**, 639.976 seconds. Fresh headless browser QA: **44 checks passed**, with the mobile completion screenshot inspected. Wheel build, exact package-source allowlist, CLI entry points, frontend syntax and workflow YAML checks passed. GitHub CI is prepared, not yet published or run. No physical Mac sleep/wake pass is claimed.

Activated 0.6.2 on the hub/Windows companion and published private Homebrew revision **12** after confirming no recent active team controllers and taking SQLite backup `.relay/hub/pre-062-20260916-225253.sqlite3`. Source build `81981d8e54b989d2def92ecd3f34cd2e00352ce66ea5cca5661890aa5dc0cbdf`; archive SHA-256 `a6aef96d50bbedb93d531e9ea61ed9000bf787fba216cc323d3191bbce5b7720`. Local/shared health, authenticated shared HTTPS, companion version, SQLite integrity, member rows, goal states and saved connection hashes passed. Private HTTPS tap clone, archive checksum and extracted CLI passed. Evidence: `.relay/patch-062-verification.json`, `.relay/activation-062.json`, `.relay/homebrew-verification.json`. GitHub destination/access and physical Mac checks remain outstanding.

## 0.6.1 reliability/UX release — 2026-09-16

The shared hub and Windows companion are activated on 0.6.1; private Homebrew revision 11 is published. Von's Mac upgrade remains pending. See [POLISH_QA.md](POLISH_QA.md) for the changes, isolated test scope, activation evidence and remaining real-world checks.

- Initial regression: 165 run, 164 passed, one skipped Windows directory-symlink fixture.
- Browser QA: **44 checks passed** using fake conversations/model responses; completion and paused-worker states added. Final mobile completion screenshot inspected.
- Native local end-to-end: installed Codex, Claude and an automatic helper completed planning, independent reviews, guarded edits, all three exact-content checks and local Git merges. No existing conversations or project checkouts were touched. This is not a third physical-PC trial.
- A real local HTTP 503 outage exercised automatic same-controller recovery with file tools blocked throughout the outage and no model-input replay.
- Two prior physical Windows/Mac trials on **0.6.0** completed successfully, including manual reconnect on the second trial. Stale event delivery and intermittent disconnects were reproduced. Their success is not evidence that the candidate has been installed or physically validated on Mac.

Final validation: **177 tests run, 176 passed, one skipped** (Windows directory-symlink capability). After the last progress-display and stale-heartbeat refinements, the focused suite passed **14/14**, including real local HTTP outage recovery and simulated sleep/wake freshness. The broad run preceded those final small refinements; its count is not presented as a rerun of the two subsequently added checks. Browser suite passed **44/44** on the final UI; JavaScript syntax and archive/package metadata checks passed.

Activated source build: `a21c3db4f7dcc32bb7365185ee4a9319e04109e3c0300173fadf1056b38da391`. After developer approval, backed up SQLite, published **0.6.1 revision 11**, and restarted only the identified Relay hub/companion quietly. Local and shared HTTPS health and companion release match. Member records, goal states and saved connection hashes are preserved; database integrity passed. Private HTTPS tap clone, archive checksum and extracted CLI checks passed. Archive SHA-256: `174b3617435dcca05c5e59be65d4cf4bccc8f5813384ce85e2b1f9d809e8a4b5`. Backup: `.relay/hub/pre-061-20260916-221447.sqlite3`. Mac installation and physical network/sleep-wake acceptance remain pending.

## Approved team automation 0.6.0 — 2026-09-14

Published private Homebrew **0.6.0 revision 10**, archive SHA-256 `44a51b79d6afe61504e5959058da735036a7f5cfdf1b0486e259658cf34ddf6d`. The hub and local companion both report version 0.6.0 / build `cccdaba57e14ea4249baa1ed715d624cc0948ca81fde0e3f63550f220e7b7c2a`. Private HTTPS tap clone, checksum and extracted CLI checks passed; native Homebrew installation on Mac remains unverified for this release. Backup: `.relay/hub/pre-auto060-20260914.sqlite3`. No live working controllers were online at activation. Member records compare equal to the backup; one enabled saved local connection remains, without a network error. Production team goals remain zero; all new execution QA ran in temporary hubs/checkouts.

- Real installed Codex, Claude and one automatically spawned Codex helper completed three disjoint tasks through planning, independent reviews, guarded writes, approved exact-content tests and local Git merges. All three tasks reached `complete` only after accepted controller receipts. Separate temporary Windows checkouts/hub; existing conversations untouched. `.relay/team-automation-native-verification.json`. This does not certify physical Mac execution or large-project correctness.
- Broad regression: **161 tests run, 160 passed, one skipped** (Windows symlink fixture). After additional hardening, focused automation suite **14 passed**: dirty-source isolation, all-or-nothing base/hash validation, path protection, success/failure, cancellation/timeouts including descendants, automatic/repeatable dependency sync, separate-branch merge, test-induced Git-history mutation rejection, owner/revision/attempt fencing, explicit retry, bounded correction routing and model-tool authority separation.
- Browser QA: **38 checks passed** including saved-login/onboarding/offline behavior, explicit consent, 390px layout, escaped content, join command hub address, integration policy display and failure/retry guidance. The inspected screenshot uses fixture data. `.relay/companion-qa/verification.json` and `shared-goals-mobile.png`. See [UX_REVIEW.md](UX_REVIEW.md) for findings and remaining usability work.
- Test and setup execution is opt-in trusted-code execution with user OS privileges, not a sandbox. No push, automatic main-branch merge, force/reset or user-checkout replacement. Helpers cannot recursively spawn or independently choose test commands. Evidence certifies the configured checks, not universal correctness or remote attestation against a malicious controller.
- Automatic controller crash/takeover is deliberately not implemented: preserved candidates/receipts may require manual reconciliation. In-process pause/resume and bounded test cancellation are supported. Physical two-PC sleep/wake and user-study acceptance remain required.

## Windows quiet-launch follow-up — 2026-09-14

Follow-up correction: the user still observed windows after the Relay patch. A WinEvent/process trace captured `CASCADIA_HOSTING_WINDOW_CLASS` and a visible pseudo-console for PowerShell PID 43128, launched by this Codex app-server PID 7148, not the Relay companion. The user identified the persistent blank window as `.codex/packages/standalone/releases/0.154.0-x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe`. Relay's flags do not control that app-owned helper. Subsequent diagnostic commands use the tool's pseudo-terminal mode; no Codex processes were killed and no Windows-wide terminal settings were changed. The Relay patch alone is **not** a completed fix for the reported app-level issue.

Local Windows launch fix: all background subprocesses now receive `STARTF_USESHOWWINDOW` / `SW_HIDE` alongside `CREATE_NO_WINDOW`. Codex and Claude explanation adapters use the same shared helper as managed workers. Supervisor launches no longer combine `DETACHED_PROCESS` with `CREATE_NO_WINDOW` (Windows ignores the latter in that combination). Interactive team terminals remain unchanged.

Seven process tests passed, including real Windows console creation after `FreeConsole`/`AllocConsole`, pipe output preservation, and supervisor flags. Eight reliability, seven Codex turn-transition and fourteen managed-runtime tests passed. Three native Codex App Server initialization/close cycles passed with no visible console at inspection, no model calls, and no existing conversation access. Evidence: `.relay/windows-spawn-verification.json`. This is an API visibility check, not a recording of every transient window or proof that unrelated desktop programs cannot flash windows. The pre-fix active Relay Codex process was also hidden at the time inspected; the exact historical flashing process has not been conclusively identified.

The fix follows [Windows process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) and [startup window visibility](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow). Codex continues using its existing [App Server stdio interface](https://learn.chatgpt.com/docs/app-server); no provider settings or protocol changes were needed. This is a local Windows source patch, not a new Mac Homebrew release.

## Automatic team coordination 0.5.0 — 2026-09-14

Built and privately published Homebrew **0.5.0 revision 9**. Archive SHA-256 `d9f6d73de244fe742d7b1f316549cc4fff69af5155d01374b1f18ebc33`; source build `512aebdeffab568538a024a7ed993f8261fb004df0f7d8199a08882125a4a5b4`.

- Final broad regression: **148 tests run, 147 passed, one skipped** (Windows directory-symlink fixture). Focused team suite: **18 passed**. Python compilation and browser JavaScript syntax passed.
- Real installed Codex and Claude agents passed automatic decomposition, independent plan review, disjoint assignment, guarded writes and cross-checkout artifact review. Both tasks stopped at `integration`, retaining the developer verification gate. Separate temporary checkouts and a temporary hub were used; existing conversations were untouched. Evidence: `.relay/team-native-verification.json`.
- Browser smoke: **34 checks passed**, including escaped shared-goal content and 390px layout. Fake QA goal data, not production goal data. Evidence: `.relay/companion-qa/verification.json` and `shared-goals-mobile.png`.
- Private HTTPS tap clone, source checksum and extracted CLI checks passed for this exact archive. Evidence: `.relay/homebrew-verification.json`. Native Mac Homebrew upgrade is still a teammate acceptance step.
- The existing shared hub and local companion were restarted quietly and report 0.5.0 with the matching build. A pre-activation SQLite backup is retained at `.relay/hub/pre-team-050-20260914T082316.sqlite3`. Member records compare equal to that backup; the existing F:/apex sharing connection remains configured and enabled. No production team goal or worker was created by QA.

Remaining acceptance: an actual Windows/Mac **team-mode** trial with both developers starting new sessions on the same repository/goal, plus real sleep/wake and outage recovery. The prior 0.4.2 physical message round trip is not evidence of automatic team-mode acceptance. At the final hub check, Von's earlier live session had no fresh heartbeat; it was not silently resumed or replaced.

This release coordinates enrolled agents only: no helper-agent spawning, automatic Git merging/synchronization, or agent-run shell/tests. Peer review is not verified integration. Goal owners integrate and test externally, then explicitly accept matching artifact hashes. See [TEAM_COORDINATION.md](TEAM_COORDINATION.md) for protocol, permission and recovery limits.

## Managed live working sessions 0.4.0 — 2026-09-14

Implemented and privately published Homebrew 0.4.0 revision 6. Archive SHA-256 `fff04e99d20fa16689819c331c776f0ba090d766095aaff420c15d0cfead5f07`; source build `34a9bbfb4fb3db517bafbf1765923d21cd56a89e2d03be7d375879a91c41ed62`.

- `live` confirms the repository and explicit task/share/write consent, reuses matching-origin credentials and launches only a new managed coding conversation. `live-release` is human-only reconciliation of a stopped managed run; no code/model action occurs.
- Full regression run: **115 tests passed**. After two additional recovery/control tests, the focused managed suite passed **9 tests**. Final compilation, JavaScript syntax, provider prerequisite checks and private HTTPS tap clone/download/checksum/extracted CLI verification passed.
- **Actual native Codex 0.154.0 and Claude Code 2.1.270** each passed guarded file creation, idle wakeup from a teammate message, explicit acknowledgement, subsequent guarded replacement and pause. A combined native run with two identities and separate checkouts passed peer review exchange and both disjoint writes. Existing conversations were never selected/resumed. Native QA used fresh temporary repositories and new QA conversations, not either developer's shared code.
- Browser smoke: **32 checks passed** with fake source data, including live-session status, escaped activity and 390px layout. Inspected `live-working-mobile.png`. Live activity also appears in the Activity tab; ordinary advisory connections remain explicitly distinct from guarded live sessions.
- Hub and companion activated on 0.4.0 after SQLite backup `pre-managed-live-20260914T001759.sqlite3`. All existing member identity/credential/permission rows match that backup; three sessions and three features remain, with zero real managed sessions launched. No existing conversation binding or agent setting was changed.

The managed toolset is deliberately limited to file listing/read/create/replace, with private backups and fresh plan/scope/HEAD/hash/controller/message checks. Shell/tests, deletion, settings writes, external integrations and automatic merging are not available inside managed sessions. Run tests in the normal terminal. Control only covers these new managed sessions; external editors/processes are not intercepted. Reservations remain on pause/disconnect/quit until explicit reconciliation.

Native Mac/Homebrew execution and physical two-PC/sleep/wake acceptance are still pending with Von. The laptop hub still needs to stay awake. See [LIVE_COORDINATION.md](LIVE_COORDINATION.md) and the `.relay/managed-*-verification.json` evidence files.

## Live coordination protocol foundation (historical source preview)

Added durable per-recipient delivery and separate agent acknowledgements, explicit live-controller ownership/lifecycle, work-check blockers for unattended events/offline peers, and pause/replan with retained reservations and revision-bound reviews. Existing ordinary connectors remain advisory; no local edit interception or provider wakeup adapter is implemented by this foundation. No real agent was enrolled, launched, resumed or reconfigured, and the private tap remains 0.3.1 revision 5.

Verification: full regression suite **105 tests passed**; expanded live-protocol suite **11 tests passed**; compilation and pending-delivery index migration passed. Isolated fixtures only. Native working-agent delivery, edit interception, receipt UI and Windows/Mac acceptance remain unimplemented/unverified. Await the user decision on new Relay-managed working sessions versus checkpoint-only existing-client integration before changing the launch workflow. See [LIVE_COORDINATION.md](LIVE_COORDINATION.md).

## Per-start repository confirmation 0.3.1

Published private Homebrew version 0.3.1 revision 5. Archive SHA-256: `a9cb0536a4f22f0fa1df4edaa05658e406b35533c117dee8864717c4c3c21c2a`; source build identity: `8675bb23e18af45f2a5de3a53302600b89673f80cb98ab3d17e489f9d5414923`.

- Every explicit CLI `start` confirms the actual Git root before authentication, network calls or sharing changes. Enter confirms, `n` selects another folder, and `q` cancels. `--repo` suggests a root for this invocation but still requires confirmation.
- CLI state is private and scoped per checkout. Saved connections from other roots are excluded; legacy connections remain in place and are never retargeted. A launcher project's preference is not carried into a different checkout.
- The full regression run passed 96 tests. After a final output-copy adjustment and an additional real CLI subprocess cancellation test, all 19 onboarding tests passed. Python compilation passed. Tests use isolated private-state directories.
- Live private HTTPS tap clone, archive GET/HEAD/checksum and extracted CLI verification passed. Native Mac/Homebrew execution remains for Von to test.
- Hub and local companion now report matching 0.3.1 builds. Local sharing is online with no error. Existing member identities, credential hashes and permissions match the pre-update SQLite backup; three sessions and three features remain. Existing repository selections were not changed.

Scope: this prompt runs on explicit Relay CLI starts, not background recovery, MCP stdio startup, GUI sharing, or every direct Codex/Claude launch. Switching selects Relay's root for that invocation; it cannot move the parent terminal or an already-running coding agent. The CLI prints a shell command for moving the terminal. No cross-PC repository equivalence is inferred from this local confirmation. Physical two-person acceptance still awaits the user's repository choice, Von's update and coding-client tool reconnection.

## Two-person reliability release 0.3.0

Implemented and privately published Homebrew version 0.3.0 revision 4. Archive SHA-256: `065beec9c991909ec9ea5c7b1b7de0c06bc3c056e752d246bd0ffd386f20f68f`. Cross-platform source build identity: `2afdef6f9bd662f75b1f1d4abb3855d021fd5a91ea9980a3622d66d03f4c8443` (source bytes, independent of ZIP compression).

- Final full suite: **89 tests passed**. Browser smoke: **30 checks passed**, desktop and 390px screenshots inspected. Test fixtures used fake transcripts/models, not private coding sessions.
- Added a real Windows subprocess crash/recovery/Quit test and an isolated two-worker explanation round trip with failed upload, persisted outbox, worker recreation and preserved pause. Login descriptors, ownership of startup entries, build mismatch, old clients, offline/revoked participants and two-sessions/one-person rejection are tested.
- Local hub and companion are running 0.3.0 under quiet supervision; their dedicated current-user Windows login startup entries were enabled with approval and verified outside the sandbox. Local sharing reports watching, no error; a real Relay tool call from the current conversation succeeded after the update.
- Private HTTPS Git tap clone, archive GET/HEAD/checksum and extracted CLI passed (`.relay/homebrew-verification.json`). No TLS verification was disabled. Native Homebrew installation is not tested here.
- Three existing member records including credential hashes remained identical to the pre-update backup; three sessions and three features remain. No conversation was switched, no token rotated, and no trial context question was sent to the real teammate.
- Live team check is correctly **not ready**: Von must update/reopen his sharing app and connect the working Claude agent; the owner's existing MCP runtime also needs a reconnect to report the new connector build. Do not reinterpret unknown old-client versions as matching.

Physical Windows–Mac acceptance and actual login/sleep/wake observations remain pending. Von confirmed availability to test; the owner will confirm which shared repository to use. Do not change existing selections until then. See [RELIABILITY_ACCEPTANCE.md](RELIABILITY_ACCEPTANCE.md). The laptop hub must stay awake/signed in; no always-on cloud service was deployed. Supervision restarts crashed children, not forcibly killed hung processes or a crashed supervisor itself.

## End-to-end UX simplification (source preview)

Reviewed the invite/browser approval journey, local source selection, agent-tool registration, returning-user navigation, shared context, questions, activity, coordination discussions, installation help and recoverable failures. The Browser Use and Computer Use transports both returned `Transport closed`; verification therefore used isolated headless Chromium and inspected desktop/390px screenshots, not native Mac or live user desktop control.

Implemented:

- A three-step setup path with one visible selection step, Back/Cancel, searchable conversations, and fresh consent after changing the selected source. Sharing scope, secret-redaction limits and model-call limits remain visible before approval.
- A clear next action after connecting: Enable agent tools. Registered tools have an actionable Finish agent connection guide; registration is not represented as verified runtime access.
- Saved-workspace state retained during outages, Retry connection, disabled unavailable actions and a last-loaded-snapshot notice for team content. No repeat installation or token entry is proposed for transient outages.
- Lazy repository discovery for returning users, remembered navigation, search across all three team views, accurate paused/offline/manual question statuses, preserved expanded discussions and a live-refreshed project selector.
- Updated hub setup/help, an OS-specific installer selector and a single-line Copy install command, including Homebrew. Daily use is distinguished from one-time installation.
- Quiet handling of browser-aborted requests (the disconnect exception previously fell into a generic OSError handler).

Verification: 75 regression tests passed. The expanded isolated browser walkthrough covers 23 checks, including empty conversation discovery and retry, search miss recovery, source-change consent reset, Back/Cancel, offline reload and recovery, question filtering, navigation persistence, discussions staying expanded, explicit registration consent and the Homebrew command shape. Fake transcripts, private temporary identities and stubbed model/registration calls only. One earlier focused run encountered a Windows temporary-file cleanup lock; the complete rerun passed. JavaScript syntax and Python compilation passed.

Preview evidence: `.relay/companion-qa/ux-join.png`, `ux-folder.png`, `desktop-before-sharing.png`, `my-agent-desktop.png`, `ux-offline-mobile.png`, `ux-hub-connect.png`, and `verification.json`. Existing real connections, agent settings and Homebrew release pins were not changed; live services were not restarted for this UX pass. Python-side companion changes require Quit Relay/reopen after updating. Native folder-picker behavior, first installation on a clean Mac/Linux machine, actual coding-client reconnection and enforced coordination are not established by these browser tests.

## Work coordination protocol (advisory source preview)

Added work plans, revision-bound peer reviews, attributed messages and atomic scope reservations over the authenticated hub API, exposed through four MCP tools. No real agent settings, hooks, source conversations, repository branches or Homebrew release pins were modified. The new panel lives inside Shared context and explicitly states that edits are not blocked.

Eleven coordination tests passed against isolated real HTTP hubs with two developer identities. They cover nonoverlapping parallel starts after peer reviews, simultaneous overlapping starts (exactly one succeeds), folder/case/interface conflicts, review invalidation, new participants, changed Git base, stale and integration-pending reservations, explicit release notes, cross-project/session/revocation boundaries, paused-sharing upload rejection, invalid paths, MCP identity binding and migration preservation. These are protocol tests, not evidence that two real coding agents have coordinated edits across PCs.

Headless Chromium onboarding and coordination checks passed with fake transcripts and model/registration stubs. Verified the advisory label, peer discussion, escaped script-like content, no JavaScript errors and no horizontal overflow at 390px; inspected `.relay/companion-qa/coordination-mobile.png`. No live team messages were created by QA.

Regression run: 74 tests passed after updating the stdio tool-inventory assertion for the four new tools. The expanded 11-test coordination module and browser smoke were then rerun successfully against final source. JavaScript syntax and Python compilation checks passed. The live hub was gracefully restarted after a private SQLite backup (`.relay/hub/pre-coordination-20260913T102400637956.sqlite3`). Authenticated verification found advisory mode, edit_gate=false, zero real work plans and the existing three member/session records; the live source ZIP includes coordination.py. Homebrew remains unchanged, and the already-running local companion must be reopened to load its updated team-data forwarding. Neither real coding agent was enrolled into coordination or had its settings changed by this work.

## Quiet background work and unified local navigation (source preview)

Fixed Windows Git subprocesses in repository discovery and repeated worker checks to use CREATE_NO_WINDOW. The native folder-picker helper uses the same background option. Codex and Claude model subprocesses already suppressed console windows. A real Windows Python child launched with this option reports no console window; repository-check tests verify the option reaches each Git call.

The local app now has My agent and Team workspace navigation. Shared context, questions, and activity render in the same local browser tab; the local server forwards only the explicit team-read and question actions using the saved identity. Private capabilities and workspace tokens are not returned by those views. URLs and administration links are in Settings. Returning users bypass completed onboarding, optional naming is collapsed, and source-selection consent remains required.

Enable agent tools requires explicit confirmation and uses the installed client registration command. Tests cover no registration without consent, no overwrite of an unrelated Codex entry, quiet subprocess flags, idempotent registration receipts, safe error messages, and excluding receipts from the connection/worker list. Current client help and official Codex MCP documentation were checked. Real user agent settings were NOT modified, and a configured receipt is explicitly distinguished from active client tool availability. Claude add failure is reported without removing any existing entry.

Verification: **64 automated tests passed**, followed by a separate rerun of the 10 companion tests after extending authorization/receipt checks. Isolated headless Chromium onboarding passed, with new same-tab context/question and explicit tool-confirmation coverage, plus inspected desktop and 390px screenshots. Model calls and registration were stubbed in this browser test. No real conversation was attached or question sent by QA. Evidence is under `.relay/companion-qa/` (including `my-agent-desktop.png`, `team-context-desktop.png`, and `team-questions-mobile.png`).

Your local companion was restarted to apply the quiet process fix. Saved connection and workspace-identity files were verified unchanged before reopening. The hub was restarted to refresh the source ZIP allowlist for new modules; the immutable Homebrew release is still revision 3, pending review of this local UI preview. Previously approved workers resume under their existing consent; no MCP registration was performed on the user's behalf. Native Mac UI verification and a Mac package update remain separate.

Live check after restart: the local Codex worker is watching with no error; saved localhost sign-in is reused, and the local team endpoint returns the three shared feature records. Von's older Claude worker is heartbeating but reports `Hub returned 502`. The hub's live HTTPS pairing checks pass. That worker error has not been cleared or treated as proof of successful summary processing; it needs confirmation/recovery separately. No error record was manually erased.

## Pairing header hotfix — 2026-09-13 (latest)

Reproduced `Missing browser request header` on the private HTTPS endpoint with the revision-2 companion's empty authorization header normalized to `Authorization: Bearer`. Local tests previously retained its trailing space and did not exercise that normalization.

New clients send `X-Relay-Client: web` explicitly and omit Authorization when no token exists. The hub also supports already-installed revision-2 companions: only anonymous `/api/pair/start` and `/api/pair/poll` accept the trimmed legacy marker, only without cookies or an Origin. Host/foreign-Origin checks remain enforced. This is not authentication: approval still requires a signed-in member, and polling requires the private device secret. No browser-header exception applies to login, approval, or workspace mutations.

The running private hub has the fix; users can retry Connect workspace without reinstalling. Homebrew revision 3 contains the client fix (`6d3bb9bb32a1f195e290e61fa358e30946c4ce2cf71c8288b6093915a48b67a1`). Ten focused companion tests and the isolated Chromium onboarding smoke passed. Eight live HTTPS protocol checks passed using native curl with TLS verification: legacy/new pairing start and pending poll, rejection of foreign origins/missing headers, and no exception for approval/login. No workspace access was granted and no conversation was shared by this network smoke. Live private tap clone/archive verification also passed.

Final full-suite rerun: **59 tests passed**. Evidence: `.relay/pairing-network-verification.json`, `.relay/companion-qa/verification.json`, `.relay/homebrew-verification.json`. The previously reported Windows Python certificate-chain issue is separate and unchanged.

## Networking follow-up

Private Tailscale Serve was activated after the owner's account-side approval. The active configuration proxies private HTTPS port 443 to Relay on `127.0.0.1:7331`; it contains no public Funnel route. The team origin is retained in the ignored hub `network.json` so normal restarts keep owner auto-login disabled.

`python tests/network_smoke.py --output .relay/network-verification.json` passed ten live checks through the actual private HTTPS address: certificate verification and health, browser assets, anonymous/invalid-token rejection, disabled local-owner bootstrap, foreign-origin rejection, existing-member authentication, secure browser login/cookie use, and the authenticated event stream. No TLS verification was bypassed, no member was created, and no source conversation was uploaded.

This proves the real HTTPS route from the hub machine, not access from a second physical PC. The friend still needs network authorization and their own Relay token. The hub process must stay running; automatic Relay startup at boot is not configured. The original QA findings below describe the earlier local-only state.

## Browser companion follow-up — 2026-09-13

The normal interface is now a loopback-only browser app with a macOS Relay.app launcher in the private Homebrew formula. Joining, browser approval, repository/conversation selection, sharing consent, and Pause/Resume no longer require terminal prompts. A background Python companion runs the already-approved workers; closing the browser or launching terminal does not stop them. Quit Relay stops the companion. Reopening restores approved connections but never enables a paused binding. Boot-time auto-start is not installed.

One-use, 24-hour invite links replace token-copying for new members. Five-minute browser approvals connect a local app to an existing workspace identity without rotating its token. Invite secrets are hashed in SQLite, browser URL fragments are removed, and transient pairing credentials are never included in shared state. The local API requires an unguessable capability plus exact loopback Host/Origin checks. Old tokens and CLI configs remain compatible.

Repository identity now accepts equivalent paths and subfolders of the same checkout, while separate worktrees/nested repositories remain distinct. Full source validation still precedes registration and upload. A mismatch remains recoverable in the GUI. We have not obtained the friend's actual recorded cwd, so this is not proof of the precise cause on his Mac.

Verification:

- Final full suite: **57 tests passed**. The companion test file also passed separately, including an actual subprocess start/quit and rejection of repository mismatches before registration.
- `python tests/companion_smoke.py` passed with an isolated hub, fake teammate and Claude transcript: invite Join, browser device approval, readable conversation selection, no registration before consent, full snapshot validation, Connect, Pause, and retained browser sign-in after reload. Worker/model calls were stubbed; no real coding history was read or shared.
- Headless Chromium screenshots inspected at desktop and 390px narrow layout; no horizontal overflow or JavaScript errors. This caught and fixed the existing global `history` function shadowing the browser History API. Desktop browser-control transport was unavailable; this was a headless app test, not a live desktop interaction.
- Live private HTTPS tap clone, native curl GET/HEAD, pinned archive SHA and extracted CLI passed for Homebrew revision 2 (`0896a96d5ee534adeccb94788eb6b4160d48d17fbc0099b083007df3d78a94aa`). Source-only `/client.zip` now permits token-free installation; workspace data remains authenticated.
- Hub restarted with its persisted private origin. Existing 3 member records, 1 manual session and 0 live bindings were unchanged. No real member was invited, revoked, or connected for QA.
- The current Windows Python HTTPS check still fails with an expired certificate-chain verification error. Native curl/Git verify the private HTTPS route successfully. TLS verification was not disabled. This remains unresolved in this Windows Python runtime; cross-PC GUI approval and native Mac app launch are not yet verified.

Evidence: `.relay/companion-qa/verification.json`, desktop/mobile/approval PNGs in the same directory, and `.relay/homebrew-verification.json`.

Remaining: one-time installation/upgrade still uses Homebrew or Python; Windows/Linux have a reusable launcher but no desktop shortcut installer; Tailscale and a running hub remain prerequisites; agent-initiated MCP questions still require separate client registration. This is a developer preview, not a fully packaged/notarized desktop release.

## Original outcome (historical)

Working developer preview. Local operation is implemented; a real teammate has not been connected. No deployment, firewall change, global agent configuration, or production conversation attachment was performed.

## UX changes

- Replaced the source-ID/transcript-path form and three setup commands with one guided `python -m relay start` flow. It discovers repository-scoped conversations, asks for explicit sharing consent, saves a separate private config, and starts the watcher.
- Repeating setup offers saved connections. Paused connections cannot be silently resumed. Declining consent creates no connection and uploads no conversation.
- Agent tool registration is a separate exact command, printed with the current Python and absolute Relay entrypoint. No pip installation or hand-edited configuration is necessary for this path. Client approvals still apply.
- Simplified navigation to Overview, Activity, Questions, and Agents; removed zero-value onboarding counters and the decorative sidebar on the context board. Increased reading text sizes. Existing notes remain available under a disclosure.
- Project creation requires only a name. Source IDs and connection diagnostics are behind Connection details. Setup & help explains local use, agent tool registration, and cross-PC requirements.
- Fixed live activity rerenders collapsing open logs. Browser QA confirmed a selected Codex log remained open when a new, explicitly labeled QA event arrived through the real hub stream.
- Reduced the default clarification wait to 45 seconds, leaving headroom within Codex's documented default 60-second tool timeout. Longer answers remain available through `relay_inbox`.

## Checks

| Check | Result |
| --- | --- |
| Automated suite | 33 tests passed: original auth/ownership/history/MCP checks plus live workers, queues, source filtering, guided setup, consent cancellation, resume, paused state, command quoting, and absolute-path entrypoint |
| Python compilation and browser JavaScript syntax | Passed |
| Real Codex + Claude guided setup | Both selected QA conversations discovered and connected; no model calls or conversation uploads in this setup-only test |
| Real two-provider round trip | Both providers generated context, answered a peer clarification through Relay, and updated their context to version 3 |
| Browser onboarding | One command, working copy button, expandable integration/privacy help, Escape dismisses dialog |
| Narrow layout | Tested with 390-pixel viewport override; content width 375 pixels excluding scrollbar, no horizontal page overflow; dialog content fits its 320-pixel inner width |
| Populated UI | Actual QA context and activity render; a streamed new event preserves the expanded source log |
| Main workspace | Existing records preserved; no private coding conversation attached |

Evidence is local, under ignored `.relay/` directories:

- `integration/ee36d268-6fff-45ef-acca-bf5be90c596d/verification.json`: six source events, two automatic answers, two version-3 contexts. A seventh, clearly labeled UI-only fixture event was subsequently added to this QA hub for stream testing; the original model-test report was left intact.
- `setup-qa/de6b5790-1390-4c66-b892-abf9ab1fcfee/verification.json`: real session discovery and guided connection passed for both clients.

The real-client tests used isolated QA conversations on one Windows machine with the installed client login. Sandboxed Codex session visibility differed from the installed client's environment, so source discovery was also verified outside the sandbox. Existing working conversations were not read or connected.

## What is still required

1. Each developer installs Python 3.11+, Git, and their signed-in Codex or Claude Code client; obtains the Relay source; and runs guided setup against their actual committed Git repository and selected conversation.
2. Each working coding client registers Relay's MCP tools using the printed command, reconnects, and approves tools as appropriate. This enables the agent itself to search and ask peers; dashboard questions and watcher activity do not require MCP registration.
3. For two PCs, one shared hub must be reachable over HTTPS or an encrypted private network. Cloud hosting is optional. `localhost` cannot be used as the friend's hub address.

Not yet verified: two physical PCs, macOS/Linux execution, large/long-lived real feature histories, overnight reconnects, or semantic conflict detection quality. This is not a production security audit or a substitute for testing on the actual team repositories. Secret redaction remains best-effort.

## One-command installation follow-up — 2026-09-13

Implemented a private-hub Python bootstrap at `/install.py` and member-authenticated source download at `/api/download/relay-client.zip`. The bootstrap installs only explicitly allowlisted application files into a per-user, per-workspace directory, preserves earlier releases and connection state, and launches guided setup with the token held in memory. It does not install Python, Git, Tailscale, or agent clients, alter existing pip packages or PATH, start another hub, or register MCP tools automatically. The small bootstrap is readable without a Relay token; the application archive and workspace APIs still require authentication.

44 automated tests passed. New coverage includes authenticated download, anonymous/revoked-token rejection, an extracted CLI with no package installation, deterministic source archives, exclusion of unlisted private files, invalid-token installation rejection, existing-state preservation on reinstall, unsafe URL rejection, and unexpected archive path rejection.

Live `python tests/install_smoke.py` passed through the configured Tailscale HTTPS hostname: verified TLS, public bootstrap without credentials, authenticated package retrieval, matching SHA-256, exact archive file list, and a runnable extracted CLI in an isolated temporary installation. It did not connect or read any coding session. Evidence: `.relay/install-verification.json`. All ten existing HTTPS/authentication checks also passed after the hub restart. JavaScript syntax passed.

Browser QA confirmed that the setup panel opened from localhost supplies the configured private HTTPS installer address, the copy button reports Copied, and the command/instructions fit the dialog. The prior one-time teammate token screen was preserved. These are Windows and host-side checks; a completed install and live agent connection on the friend's physical PC remain unverified.

## Private Homebrew tap follow-up — 2026-09-13

Added a real private Git tap at `/homebrew/tap.git` and `relay-workspace` formula, with Python 3.13 and Git dependencies, a non-conflicting `relay-workspace` executable, and immutable SHA-256-pinned source releases. The host command `python -m relay.homebrew --data .relay/hub` updates only managed packaging artifacts; it preserves old releases and advances the formula revision when packaged source changes. No GitHub repository or public Funnel was created. Homebrew installation does not start agents, register MCP tools, or grant access to workspace data.

The tap and its source-only release files intentionally require private-network access but not a Relay token. The original member-authenticated ZIP and workspace APIs remain protected. Only explicit Git discovery/object paths, the formula, and content-addressed archives are served; Git config/hooks, arbitrary hub files, tokens, and context are excluded.

The full 48-test suite passed; after adding HEAD support the four Homebrew tests passed again. Coverage includes a real Git clone using Homebrew's clone arguments, source checksum and CLI verification, idempotent publishing, protection of unmanaged directories, token exclusion, and denial of traversal/private Git paths. Existing ten live HTTPS/authentication checks passed after the server restart.

Live `python tests/homebrew_smoke.py` passed using Windows Git and system curl with default certificate verification: HTTPS tap clone, source GET/HEAD, matching pinned SHA-256, and an extracted CLI. Evidence: `.relay/homebrew-verification.json`. Sandboxed Windows Git first failed to access Schannel credentials. Elevated Python's urllib subsequently reported an expired certificate chain, including on the direct connection; this was not bypassed or repaired. The final Git/curl checks used the native TLS stack successfully, not disabled TLS verification.

Native Homebrew install/test and Ruby syntax evaluation remain unverified: neither Homebrew nor Ruby is installed on this Windows/Ubuntu WSL environment. No Homebrew installation, macOS test, or second-physical-PC test was claimed or performed.
## Homebrew live-start recovery 0.4.1 — 2026-09-14

Von's reported startup reached the live controls, then exited with `Live session paused. Use /resume first.` Code inspection identified a Homebrew-specific failure path: the stable `opt` symlink is preserved by `launch.py`, but version reporting attempted to archive that unresolved path and rejected its symlinked ancestor. The heartbeat treated that local reporting exception as a hub outage; the first task offer was outside the recoverable command loop.

Version reporting now resolves only the installation root, retaining the archive's internal symlink rejection and file allowlist. Optional release reporting no longer invalidates a successful coordination poll. Initial task-send errors pause with controls available and never automatically retry uncertain delivery. A pending coordination fault still blocks new task offers and clears only on explicit resume.

Verification: managed-session suite 11 tests passed, including reporting failure and initial-task recovery regressions. Canonical-path regression passed; the actual directory-symlink fixture is skipped on this Windows host because symlink creation is unavailable, including outside the sandbox. Native Mac retry remains required; this is not evidence of a successful launch on Von's machine.

Additional checks: live coordination 11/11, reliability 8/8, Homebrew packaging 4/4, Python compilation passed. Published private Homebrew **0.4.1 revision 7**, archive SHA-256 `12fce3cf17b68650a29fb6fa9f63ac57ec2a3e7741e6c9c16e92ef2c448eee73`. Live private tap clone, TLS-verified GET/HEAD, archive checksum and extracted CLI checks passed. Client-only update; the existing compatible hub was not restarted, and existing conversations/settings were not changed.
## Codex turn-transition recovery 0.4.2 — 2026-09-14

The first physical read-only Windows/Mac trial failed on `Codex: no active turn to steer`; `/resume` then encountered a closed App Server. Preserved evidence: `.relay/physical-two-pc-20260914.json`. This trial is not counted as a pass.

The fix drains queued completion notifications before scheduling more work and distinguishes explicit JSON-RPC rejections from uncertain transport failures. Only the exact `turn/steer` rejection `no active turn to steer` permits one re-offer in a fresh turn, with a new tool budget and timeout. Timeouts, disconnects and other rejections are never automatically retried. Stale completions cannot clear a newer turn. An explicit no-active-turn interrupt rejection is harmless; a closed provider is rejected before `/resume` can claim success.

Official lifecycle reference used: https://learn.chatgpt.com/docs/app-server (steering requires an active matching turn; completion is notified asynchronously).

Verification: full suite **131 tests run, 130 passed, one skipped** (directory symlink creation unavailable on this Windows host). Seven provider-transition tests and fourteen managed-runtime tests passed. Compilation passed. Published private Homebrew **0.4.2 revision 8**, archive SHA-256 `249cdac8922d800972060384ccebab6946f65253e62a2d92ce3a622ee12d776f`. Live private Git clone, TLS GET/HEAD, checksum and extracted CLI checks passed. Existing compatible hub not restarted. Physical rerun evidence is recorded separately from the failed first attempt.

**Physical read-only rerun passed:** Windows Codex on 0.4.2 in `F:/voca` and Von's existing Mac Claude on 0.4.1 in `/Users/vonners/DevProjects/VocareGRC_Demo` exchanged challenges and confirmations automatically. Matching Git repository identity and `native-apps` branch verified. Message ledger **18 → 19 → 21 → 22**, all delivered and acknowledged by their intended live recipients. Both genuine agent replies were observed; the older non-live Mac connector was excluded. The exact turn-boundary fallback fired during receipt of the closing confirmation and recovered without pausing or manual message forwarding. Evidence: `.relay/physical-two-pc-rerun-20260914.json`. No guarded writes recorded, Windows scope file absent, Mac agent reported no file changes. Plans remain planning (not reserved). This does not certify parallel edits, overlap blocking or physical offline/sleep recovery.
