# Relay Next verification

## Native Claude session integration 0.8.0-alpha.13 - 14 October 2026

- Windows local checks: Node/Worker typechecks and 106 tests passed (one POSIX launcher test skipped). Local Worker integration verified native idle wake-up, messages held during busy turns, unrelated-conversation isolation, listener cancellation, existing channel compatibility, and the existing shared-budget tests.
- A real Claude Code 2.1.299 process, using the installed login and an isolated local Worker, automatically registered and answered an idle message without channel flags or a special launcher. A second message sent during work was answered after the requested work completed. No existing peer conversations were used. The opt-in reproducer is `npm run test:claude-native`, with a $0.50 model budget.
- Source tests cover concurrent attachment, native-ID recovery, provider separation, `/clear` transport rebinding, stale Stop rejection, normal permissions, and preserving unrelated hooks. No workspace or transcript content is used to identify a conversation.
- Cross-platform CI, hosted rollout, local installation upgrade, and public npm publication are pending for this version. Interactive GUI and physical two-device acceptance remain unverified.

## Project-folder launcher 0.8.0-alpha.12 - 14 October 2026

- Windows local checks passed: Node/Worker typechecks, 103 tests (one POSIX-only test skipped), strict release packaging, and isolated package setup for Claude and Codex.
- GitHub Actions passed on Windows, macOS, and Linux for implementation commit `1962874`: https://github.com/vision-27/relay/actions/runs/38527889570.
- Launcher tests execute a stub agent in the inherited/chosen directory. Windows covers shell metacharacters in paths, forced folder selection, cancellation, missing folders, drive-root rejection, and the generated batch wrapper. POSIX coverage includes inherited directories and Linux chooser selection/cancellation.
- The installed Windows desktop launcher was backed up and updated. Interactive native folder-picker visual QA has not been performed; tests substitute the selection result. No hosted Worker change is required.
- Published `@platys/relay@0.8.0-alpha.12` under `latest`. Anonymous registry lookup, a fresh global install, npx version, and setup-page HTTP verification passed using empty npm configs and a fresh cache. The existing alpha.10 desktop installer does not contain this fix.

## Public npm installation 0.8.0-alpha.11 - 14 October 2026

- Published `@platys/relay@0.8.0-alpha.11` publicly under the `latest` tag after the npm maintainer completed publishing authentication. The package is available without GitHub access or an npm account; the existing desktop alpha.10 GitHub download remains separate.
- Node/Worker type checks, all 102 local tests, and isolated packaged setup for both clients passed. The runtime accepts the new package name and the prior archive identity for upgrades. Temporary test cleanup now tolerates short Windows file locks while retaining canonical target checks.
- [The publication branch CI](https://github.com/vision-27/relay/actions/runs/38521218521) passed on Windows, macOS, and Linux, including package installation and desktop launcher smoke checks. Physical multi-device agent acceptance remains separate.
- Verified anonymous registry metadata, a global install into a temporary prefix, npx CLI execution, and the installed setup page over HTTP. The probe used separate empty user/global npm configuration files and a fresh cache, with authentication environment variables removed. No real client configuration or membership was changed by this verification.
- Commands: `npx --yes @platys/relay setup`, or `npm install --global @platys/relay` followed by `relay setup`. The published archive includes the user guides and compiled runtime only. No hosted Worker deployment occurred.

## Packaged beta 0.8.0-alpha.10 - 14 October 2026

- `relay setup` now defaults to the hosted MCP browser setup. Explicit `--legacy-network`, legacy invitation codes, and operator `--server` setup retain the older connector path. Updated legacy regression tests select that mode explicitly.
- Node/Worker type checks and all 102 automated tests passed on Windows. The installed npm package smoke passed with isolated Codex/Claude configuration; the local Worker official SDK smoke passed invitation enrollment, question/reply, Claude channel delivery, reconnect replay, isolation, revocation, and budget pause. No real peers or model calls were used for these release checks.
- Added an allowlisted npm release archive and SHA-256 checksum, current setup/update/uninstall/troubleshooting guides, and tag-driven GitHub prereleases gated on the three-OS CI matrix. The package remains private and unpublished to npm; existing GitHub visibility is preserved.
- Built the Windows executable with bundled Node 22.20.0 and exercised extraction plus runtime version verification. It is unsigned. Visual setup QA, physical macOS/Linux and two-computer acceptance remain pending. See the matching GitHub Actions run for remote matrix results; local Windows checks alone do not establish them.
- Packaging does not deploy the hosted Worker or update installed device runtimes. Users rerun setup to activate a package update.
- [The tagged release workflow](https://github.com/vision-27/relay/actions/runs/38518216075) passed on Windows x64, Linux x64, and macOS arm64 and published all three desktop artifacts plus the npm archive and checksums. This establishes clean-runner installation, transport, and launcher smoke evidence, not physical-device agent acceptance. An earlier Windows branch run stopped the replay fixture at 400 of 425 records; the follow-up test allows bounded recovery ticks and reports sync errors while still requiring all 425 records and the exact final cursor.

## Guided remote setup 0.8.0-alpha.9 - 14 October 2026

- Added a GUI installation path for hosted invitation links. It redeems a membership privately, installs an immutable local runtime, configures the Codex companion/hooks and Claude channel at user scope, and creates a Claude desktop launcher. The Windows desktop location is resolved through the OS so redirected desktops are supported. Existing unrelated MCP/settings entries are preserved and writes are backed up. The setup page has a guarded launch button and room link; users do not copy tokens, edit JSON, install Node/npm/Git, or enter a launch command.
- Desktop builds now start `setup --remote --web`; legacy network setup remains available through its existing CLI options. Claude's own development-channel confirmation is retained, with ordinary permission and organization policies unchanged. The generated launcher is for future Claude sessions; already-running clients still need a reload/reopen.
- All 101 tests passed on Windows. After the final success-heading and OS desktop-path corrections, the seven focused remote/browser setup tests and Node/Worker type checks passed again. The local Worker SDK smoke redeemed an actual invitation through the new installer, repeated installation without re-enrollment, then connected the installed Claude channel and listed its ten tools. Other channel/reconnect/isolation smoke checks also passed. No new model calls or real peers were involved in this increment.
- Built and exercised extraction/runtime startup of `.relay/releases/RelaySetup-0.8.0-alpha.9-win32-x64.exe`. SHA-256: `f1e097ea77f4271f76c3aa9b65521b2bf270e1d2a407c385923e56cd49c88484`. It bundles Node 22.20.0 and is unsigned. No user code-signing certificate is available in this environment.
- Browser security denied opening the loopback setup page in Opera, so no workaround was attempted. Visual QA and actual button-to-native-client launch remain pending; automated HTTP/DOM-reference tests cover the setup/launch contract. The isolated preview server was stopped. Mac/Linux launchers are generated by the existing OS build matrix but were not run on physical devices here. No production Worker deployment, public package upload, or actual user config change occurred.
- This is a guided install preview, not a finished public one-click release. Remaining work: installer signing, macOS notarization/device tests, a hosted download path, visual/native launch QA, and Claude's external channel allowlisting constraint. See [easy setup](EASY_SETUP.md).

## Claude channel 0.8.0-alpha.8 - 14 October 2026

- Actual Claude Code 2.1.299, authenticated with a first-party Pro account on Windows, connected to the isolated hosted Relay fixture. Ordinary HTTP MCP `relay_open` / `relay_check` / `relay_close` passed. An initial headless run had tool-permission denials; the retry with an explicitly scoped QA launch succeeded. This is separate from channel-trigger verification.
- Added `next/node/claude-channel.ts`: a local stdio MCP bridge advertising `claude/channel`, listening to the hosted room WebSocket, and emitting only messages for the bound conversation. It uses the agent's own validated key, does not emit keys in channel events, suppresses duplicate events within a running process, honors the shared client budget, and keeps acknowledgement/answer receipts explicit. A closed bridge rejects reopening rather than returning a stale cached key.
- Real idle test: question `e5191f58-8cd5-43ce-b5ba-ee5f6285ffa9` was sent at `04:04:53.363Z`; Claude's actual `relay_reply` was recorded at `04:04:56.505Z` with text `claude idle channel works`. No manual user turn was submitted after sending the room question. Evidence: `.relay/claude-qa/idle-proof.json`.
- Real busy test: Claude began `sleep 20` at `04:08:19.858Z`. Question `f965c10c-95c0-4a88-b749-66522cbb9000` arrived at `04:08:31.921Z`; the tool completed at `04:08:43.140Z`; Claude replied `claude busy channel works` at `04:08:45.432Z`. It did not interrupt the command. Evidence: `.relay/claude-qa/busy-proof.json` and native Claude transcript `32fb2555-0aa4-44b2-8f75-f194b462d638`.
- Real Codex-to-Claude exchange: this current Codex controller opened its own isolated fixture session and asked Claude about the verified scenarios. Claude replied substantively through Relay; Codex read and acknowledged that reply. Claude put its follow-up question inside the reply rather than initiating a separate `relay_ask`, consistent with its narrow test instructions. Do not count this as a separate Claude-initiated question test or two-machine test. Evidence: `.relay/claude-qa/cross-agent-proof.json`. Both QA sessions were closed and the Claude process exited after testing.
- All 96 unit/integration tests passed. Node and Worker type checks passed. The official MCP SDK local Worker smoke additionally passed channel capability/discovery, real stdio notification delivery, repeated-open protection, wrong-provider/key rejection, restored-key attachment, exact-target isolation, actual WebSocket disconnect/reconnect with pending replay, duplicate suppression and closed-channel rejection. The first reconnect assertion raced an in-flight initial inbox check; the fixture now waits for startup to settle and requires a new open socket before asserting recovery. No model calls occur in this smoke.
- The npm archive installation/setup smoke passed on Windows with isolated Codex/Claude configurations and no models. The archive remains a local developer preview; no npm publication or production Worker deployment was performed. The channel uses the existing hosted protocol.
- Claude's custom channel support currently requires an interactive development flag and its own confirmation screen. `claude -p` does not enable that channel path. Public allowlisting/one-click install, physical macOS/Linux and second-computer tests remain outstanding. If the MCP process restarts in a resumed conversation, the model must reattach with `relay_check` and its retained key; recovery after losing that key is not implemented. See [preview setup](CLAUDE_CHANNEL.md).

## Delivery companion 0.8.0-alpha.7 - 14 October 2026

- Deployed Worker `74205692-fd3e-45a6-8cbc-dc947521be95` with member-scoped companion handoff endpoints. The optional local listener uses room WebSocket notifications and the installed Codex native queue; the stdio MCP wrapper starts it with the MCP connection. Native conversation IDs are matched against local session filenames, without reading/uploading transcripts or choosing shared workspaces.
- Live idle test: room question `97b83a85-347b-46c9-b715-88926ed8abab` arrived at `03:48:27.745Z`; the companion follow-up entered the original native conversation at `03:48:29.618Z`, with no manual nudge. Actual reply `32242b71-e6e4-49a4-8151-b5b3776e140f` answered at `03:48:39.123Z` with `companion idle delivery works`.
- Live busy test: a controlled no-op task started at `03:49:09.461Z`. Room question `1f45de0a-2151-4f1d-b71c-fae776d71442` arrived during its wait. The agent answered after the wait at `03:49:48.507Z`; the queued native follow-up only entered at `03:49:54.141Z`, after the previous turn completed at `03:49:53.983Z`. No turn interruption occurred. The follow-up found the already handled inbox and did not duplicate the answer. The initial busy task was a manual diagnostic setup; delivery of the room question used the companion.
- All 95 tests present at the full-suite run passed; the subsequent seven companion tests (including the added installer preservation check) passed, as did Node/Worker type checks and the updated local Worker smoke. Smoke coverage includes the actual stdio MCP wrapper, event-driven native handoff through an injected executor, duplicate suppression, membership isolation, and budget pause. Live idle/busy evidence is in `.relay/dashboard-qa/companion-live-proof.json`, `companion-busy-proof.json`, and `companion-native-timeline.json`.
- Installed an immutable runtime under the user's `~/.relay/remote-companion` and backed up/replaced only the `relay_remote` Codex entry. A temporary hidden listener supplies the already-running client until its next MCP launch, then hands over. Future MCP connections start their own listener automatically. The trusted hooks and existing conversation keys remain in use.
- The installed MCP wrapper connected to the hosted server and listed all 10 tools. Starting it terminated the temporary listener through the handover marker; after this test connection closed, a fresh temporary listener was started for the current still-open HTTP client. No additional model was launched for this wrapper test.
- This verifies the current Windows Codex installation and same-machine native delivery. Mac/Linux runtime code is portable but not device-tested. Claude automatic wake-up, an independent AI responder, and a published one-click installer remain unimplemented. The hosted-only HTTP configuration still cannot wake idle clients.

## Trusted hooks live check - 14 October 2026

- The two reported `platypus` questions arrived after the recipient's previous turn ended. Trusting hooks did not start another turn. A one-time native `codex queue` diagnostic resumed the verified original conversation; its UserPromptSubmit hook supplied attachment instructions, and the recipient called `relay_check` with its own key and native conversation ID.
- Both questions (`c6181b12-3ee3-44f1-be1d-7d9c612b27a3`, `51fc8229-5de8-4278-b20e-5cc336a05f47`) now have actual `platypus` replies and `answered` receipts. This initial recovery used the explicit native nudge.
- During that turn, a new user question (`6416052c-cfda-4480-a414-400b8af79ee5`, "okay so wassup") was supplied by the real Stop hook at `2026-10-14T03:28:55.173Z`. The model continued and replied through Relay; the hosted receipt is `answered`. This verifies actual trusted hook attachment and turn-end continuation in the user's Codex conversation, beyond synthetic MCP tests.
- Evidence: `.relay/dashboard-qa/trusted-hooks-proof.json` and the recipient's native transcript. No application code changed or deployment was required. Hooks still do not wake idle conversations; keeping a conversation open alone does not run inbox checks. Claude and two-machine automatic delivery remain unverified.

## Queued-message repair 0.8.0-alpha.6 - 14 October 2026

- Diagnosed the reported message as persisted but waiting for the recipient to call Relay. Its recipient later read it through MCP (`accepted`); a one-time `codex queue` nudge to the verified original native thread prompted an actual `relay_reply`. Message `e54f367c-467a-42c2-9753-d85b0f0e1c6e` reached `answered`, with reply `6a3bbd91-8a4d-4ab0-97d1-f0046e9a67bf`. This is a real same-machine Codex response, not proof of automatic hooks or two-machine acceptance.
- Added optional Codex MCP tool hooks at UserPromptSubmit and Stop. Exact native-session attachment preserves existing inboxes; recovery rotates a hashed conversation key. Stop continuation is bounded, recently supplied messages are suppressed, and hooks never claim the model read or answered a message. No prompt, transcript, files, or tool outputs are sent by the hook configuration.
- All 89 tests and Node/Worker checks passed. Official MCP SDK Worker smoke passed the new hook-to-reply path alongside existing isolation, revocation, budget and WebSocket checks. Hosted synthetic hook delivery also reached `answered` and verified the continuation guard. Proof: `.relay/dashboard-qa/hook-proof.json`.
- Deployed Worker `ae2018e3-3029-4b30-8b88-7bf37aecd635`. Hosted browser QA verified the automatic inbox setup disclosure; one browser-extension content-script error was recorded, with no Relay app error observed. Screenshot: `.relay/dashboard-qa/queue-fix-setup.jpg`.
- Installed the two configuration-only hooks in the user's `~/.codex/hooks.json`, preserving other hooks. The existing `relay_remote` HTTP MCP remains enabled. Reopening the client and reviewing/trusting the exact hooks in `/hooks` is still required by Codex. Actual automatic hook execution has not yet been verified. Idle wake-up and Claude automatic delivery remain outside this change.

## Shared room QA follow-up - 14 October 2026

- Fresh Node/Worker type checks and all 84 automated tests passed. The local Worker test with official MCP SDK clients passed invitation enrollment, reconnect, isolation, revocation, browser messaging, WebSocket close and shared-budget pause.
- Browser QA reproduced an account-switch defect: sign-out left an unsent draft and recipient selection visible to the next member on the same tab. Fixed by clearing room data, drafts, reply state, filters and notices. Delayed HTTP responses from the old membership cannot overwrite or stop the new room. Three client regression tests cover these boundaries; switching synthetic members in the browser now leaves an empty draft and recipient.
- Desktop and 390px mobile QA passed browser question/MCP reply, explicit mark-read, browser reply to an agent question, safe literal HTML display, personal conversation filtering, search, mobile navigation and invitation generation. History loaded 50 recent messages, then all 65 records without duplicates. Mobile document width was 375px within the 390px viewport. Browser warning/error logs were empty.
- A Windows desktop packaging test intermittently failed relocating its newly copied executable with EPERM. Added a bounded three-second retry for Windows EPERM/EBUSY only; relocation and execution after relocation are still mandatory. The final complete suite passed, with its output saved under `.relay/dashboard-qa/qa-final-tests.log`.
- Deployed QA fixes as Worker `fcd9ca73-365a-43b1-a798-f51f62c3a816`. Fresh hosted synthetic acceptance passed page load, human identity, live notifications, MCP reply, answered receipt and explicit acknowledgement. No real peers or models were contacted. Hosted proof: `.relay/dashboard-qa/hosted-proof.json`.
- Browser screenshots: `.relay/dashboard-qa/qa-desktop.jpg` and `qa-mobile.jpg`. Signed-in browser checks used the isolated local fixture; hosted messaging used the API test. Physical two-machine Claude/Codex behavior and automatic model wake-up remain unverified.

## Shared room 0.8.0-alpha.5 - 14 October 2026

- All 81 automated tests passed on Windows. After final acknowledgement and client-state refinements, the 10 dashboard/remote-MCP tests and Node/Worker type checks passed; the local Worker interoperability smoke passed again.
- Browser QA in Opera used a clearly labeled local test room with three synthetic sessions. A form-submitted question reached an MCP session; its reply appeared through live WebSocket updates with an `answered` receipt. Agent filtering and invitation generation passed. The 390px phone layout showed no horizontal overflow, and browser warning/error logs were empty. The viewport override was reset afterward.
- Reading room history cannot acknowledge a message for an agent or another person. Human messages use a dedicated member-owned session; mark-read is explicit. Tests cover immutable retries, paginated replay, single-use/expired/revoked socket tickets, origin checks, network isolation, and oversized inputs.
- Hosted synthetic acceptance on Worker `84978bc1-d282-4ded-8bc3-27855639c40c` passed browser identity, WebSocket notifications, an MCP reply, `answered` receipt and explicit human acknowledgement. Synthetic agent membership was revoked after the test; no real peer or model was used.
- Final deployed Worker `c2a1f116-92cc-45b5-aea6-8eaeb55587bf` normalizes reserved WebSocket close codes. Node/Worker checks and the local Worker smoke passed with a no-status browser-close regression. Hosted normal close, reconnect, app and health checks passed afterward; proof is `.relay/dashboard-qa/hosted-close-proof.json`.
- Public `/app` loaded in the browser. Browser security policy blocked automatic navigation to the private local sign-in launcher; the user's room link is saved privately under `.relay/remote-mcp/room-link.txt`. Signed-in visual QA used the local fixture, not the user's hosted membership.
- Full agent transcripts, automatic native triggering, shared editing, multi-room administration and physical two-machine/model acceptance are outside this increment. Private synthetic hosted proof is `.relay/dashboard-qa/hosted-proof.json`.

## Hosted MCP 0.8.0-alpha.4 - 14 October 2026

- Windows: all 76 automated tests passed; final targeted remote-MCP tests and Node/Worker type checks passed after tightening acknowledgement validation.
- Two official MCP SDK clients exchanged questions/replies through an isolated Cloudflare Worker. Enrollment, retries, reconnect, per-conversation keys, cross-network isolation, revocation, and the shared account budget pause passed. Windows emulator cleanup retries handle delayed SQLite handle release.
- Deployed Worker version `7d9f1a7f-e69e-4abc-8794-75d950a6d2c2`. A hosted synthetic exchange reached `answered`; both synthetic sessions were closed and the synthetic peer's membership revoked afterward. No real peer was contacted and no model was launched.
- Added `relay_remote` to this user's Codex and Claude Code configurations with backups. `codex mcp get relay_remote --json` confirms an enabled HTTP entry; `claude mcp get relay_remote` reports connected. Existing MCP entries were preserved. Current sessions need to reopen/reload to gain the tools.
- The invitation page provides an MCP URL and token. HTTP enrollment and security headers were tested; visual browser QA of this new hosted page was not performed. No OAuth sign-in or one-click client configuration is claimed.
- Private connection files, invitation, activation record, and hosted evidence are in `.relay/remote-mcp/`. This alpha requires an agent to call Relay to receive messages; actual model adherence to work-boundary checks and physical two-machine use remain unverified.
- npm audit reports four existing high-severity findings in the Wrangler/Miniflare development dependency tree; no production dependency was added for this endpoint. The official MCP SDK is a development-only interoperability test dependency.

## Desktop onboarding 0.8.0-alpha.3 - 14 October 2026

- New guided, browser, and scripted connections attach across all workspaces by default. Tests register Codex and Claude sessions in unrelated folders without workspace selection and verify context/presence tools are ready.
- Windows: all 71 tests, Node/Worker type checks, and actual npm package installation passed. Tests cover the two-field setup flow, unauthorized/cross-origin browser requests, invitation failures/retries, and bundled Node persistence after the original extraction is moved away.
- Browser QA in Opera completed the real setup form against a loopback fixture, detected both clients, and visibly reached the success screen. Only temporary client configs were modified; no real account, peer, or model was used.
- Built the Windows x64 self-extracting desktop executable and exercised its extraction and bundled runtime through `--smoke-test`. This test does not open a model or activate the user's actual integration.
- Fixed a startup race exposed under concurrent tests: the connector lock is now published as a complete record using an exclusive hard link, avoiding an observable empty JSON file.
- macOS app/Linux launcher packaging and artifact upload are configured in the existing OS CI matrix. Those platforms were not run locally. Desktop artifacts are unsigned; Windows signing, macOS signing/notarization, and public distribution remain release work.
- This is onboarding verification. Automatic native message processing and a real two-machine exchange remain acceptance work; no production deployment or friend contact occurred.

## Guided setup 0.8.0-alpha.2 - 14 October 2026

- Windows: Node/Worker type checks and all 68 automated tests passed.
- Onboarding fixtures cover the guided invitation/name/sharing flow, Windows command shims and client config overrides, paths with spaces, repeated setup with the same single-use invitation, folder-policy preservation, and preflight conflicts before invitation consumption.
- A relocated runtime starts and serves MCP after its original download directory is moved away. No model or external service is used in that fixture.
- The package smoke packs and installs the actual tarball, invokes the installed `relay` alias through npm, joins a loopback network, installs both global client configurations into temporary directories, and starts the persistent runtime. This passed on Windows without model calls.
- The existing Windows/macOS/Linux CI matrix now includes that package setup smoke. macOS/Linux native execution and CI results have not been verified in this local run.
- Network invitation tests verify that owners can invite through MCP, ordinary members and sessions with the wrong local key cannot, and invitation redemption remains single-use.
- No real client settings were changed, no production service was deployed, and no friend was contacted. Browser sign-in and public npm distribution remain unfinished. End-to-end automatic native delivery still needs acceptance on each client/platform; setup success is not a delivery receipt.

## Relay Network 0.8.0-alpha.1 — 14 October 2026

- Windows, Node 22.20.0: Node/Worker type checks, all 59 automated tests, and the existing two-connector demo passed.
- Network tests cover discovery and questions/replies across different Git repositories, non-Git onboarding, workspace exclusions and changes, captured provenance after offline queueing, per-session local credentials, revocation, global installer preservation/collisions, and shared connector startup/stop/resume.
- An isolated Cloudflare local emulator passed network-mode creation, cross-repository join and registration, message deduplication, source replies and answered receipts, repository-operation rejection and membership revocation. The hosted service was not changed.
- Confirmed Claude's custom `CLAUDE_CONFIG_DIR` MCP config location using its installed CLI and a temporary, unauthenticated configuration. This did not start a model.
- Build artifacts are under `.relay/network-dev/`. No real friend's agent was contacted, no model-credit acceptance was run, and no actual coding-client global configuration was activated. Real Codex/Claude loading and a two-machine exchange remain acceptance work for this version.
- This version implements one invited group per installation; group members can access shared network records. It does not yet implement a private pairwise friend graph or automatic semantic routing.

## Project admin delegation — 1 October 2026

- Added owner-only promotion/demotion with a persisted role-change audit. Admins can invite ordinary members and revoke ordinary members; they cannot change roles, revoke owners/admins, impersonate sessions or create hosted projects using their membership token.
- Windows validation: Node/Worker type checks and all 40 tests passed. Local Cloudflare emulator and isolated hosted fixtures passed role, invitation, demotion, revocation and project-isolation checks; the existing local Worker messaging/collaboration smoke passed.
- Deployed Worker version `b387782d-e915-4cbf-ba53-b4e8c272f5b3`. Promoted `VonClaudeCakes` in the DA-Agent project with its owner's authorization and verified the hosted membership is `admin`; Nalin remains owner. Existing alpha.2 clients can use `invite` without reinstalling. This is server-side authorization, not remote agent execution or a new native macOS acceptance result.
- Private fixture evidence is in `.relay/admin-access/local-proof.json` and `.relay/admin-access/hosted-proof.json`.

28 September 2026. Windows; Node 22.20.0.

## 0.7.0-alpha.2 collaboration implementation

- Node and Worker type checks pass; 39 automated tests pass on this Windows workstation.
- Added exact artifact transfer (including a multi-chunk fixture), per-file and bundle hashes, isolated prepare/validate/accept, dirty/conflicting/stale input rejection, post-validation mutation checks, lease ownership/expiry/handoff/dependencies, integration serialization and verified archival.
- Local Cloudflare emulator checks protocol 2 using real SQLite Durable Objects: chunk sealing/retrieval, reservation conflicts, shared acceptance serialization, stale revisions and pinned artifacts; existing WebSocket/revocation checks still pass.
- Against the preceding implementation, one synthetic 25-character question with 50 changed paths shrank from 2,846 to 782 envelope characters. Default budgeted context for six synthetic decisions shrank from 23,798 to 4,492 serialized characters, with omitted evidence explicitly retrievable. This comparison includes the new output budget and is not a same-content tokenizer or billing measurement.
- Hosted alpha.2 health and protocol 2 checks pass: authenticated multi-chunk transfer, reservation conflicts, concurrent acceptance serialization, stale revision rejection and referenced-artifact retention. Existing hosted messaging and isolation checks also pass.
- No model-credit tests or physical two-computer acceptance were run for this revision. Both clients still need to load the updated integration separately from the hosted deployment.

## 0.7.0-alpha.1 verified locally

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
- Active alpha.2 deployment: `94b06bed-cf59-4c7d-ba38-bcd23b398959` (28 September 2026); HTTPS health reports `0.7.0-alpha.2` in Cloudflare mode.
- Hosted acceptance passed: HTTPS health, operator creation gate, repository identity, one-use invitations, authenticated WebSocket invalidation, idempotency/conflicting reuse, ordered replay, recipient ownership, source reply receipts, project isolation, revoked-token rejection and socket closure.
- That probe used two fixture members in a newly created isolated project. Two fixture events remain; no real agents or existing project data were used. This is functional hosted verification, not a load benchmark.
- Operator secrets and the detailed acceptance record are under the ignored local `.relay/` directory. Credentials are not included in this document or the CLI package.
- Alpha.2 collaboration verification used an additional isolated fixture project, with three artifact chunks and protocol 2 checks. Its members were revoked/closed afterward; existing projects were not modified. Local evidence is recorded in `.relay/cloudflare-hosted-proof-alpha2.json` and `.relay/cloudflare-collaboration-proof-alpha2.json`.

No teammate's live session was modified during testing. Native Claude and hosted transport were verified separately; a real two-computer agent exchange remains an acceptance step.
