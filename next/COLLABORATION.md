# Collaboration workflow (0.7.0-alpha.2)

This release adds protocol 2 to the existing Node/Cloudflare service. Upgrade the service first, then both clients. Existing project memberships, invitations and session IDs are retained. Resume coding sessions to load the new MCP definitions. New clients retain protocol-2 events in their outbox when the service is still protocol 1.

## Establish the actual connection

Install the packaged CLI with `npm install -g /path/to/relay-workspace-cli-0.7.0-alpha.2.tgz`, then run `relay-next --version` and `relay-next doctor` inside the connected checkout. Doctor distinguishes command availability, service access, connector process, MCP startup and registered coding sessions. It reports conflicting legacy Codex integrations by name. It never disables other integrations automatically.

If an existing terminal cannot find the command, add the directory returned by `npm prefix -g` to its PATH (on macOS/Linux the executable is in that prefix's `bin` directory). After installing an update, run `relay-next connect --provider codex` (or `claude`) in the existing connected checkout. It preserves membership, refreshes hooks/MCP paths and requests its older connector to stop before starting the new one. Coding sessions are not stopped. Resume the coding client once afterward. No new invitation is required.

## Prefer shared facts to another model turn

`relay_project` returns the accepted revision, current task leases and compact decisions. `relay_context` searches recorded evidence; results include source, observation time, revision/dirty state, retrieval coverage and event IDs. `relay_event` expands an exact event in character ranges. These reads do not wake a peer model. Old evidence is not a fresh owner answer.

`relay_ask` still addresses an exact session. Reply briefly using `relay_reply`; its default final phase also acknowledges the question. Retries of the same final answer reuse its ID. A changed final answer needs an explicit progress correction or a new question; it is not silently rewritten. Use `phase: "progress"` for intermediate updates. Progress is delivered through hooks without a native wakeup; background context keeps the latest progress for a question, while explicit history queries can retrieve earlier updates. Batch `relay_ack` with `event_ids` when receipt is needed without an immediate substantive answer. Do not poll acknowledgements.

## Reserve work

Call `relay_task` with:

```json
{"operation":"claim","session_id":"YOUR_SESSION","title":"Update login contract","paths":["src/auth"],"dependencies":[],"ttl_seconds":900}
```

Keep the returned task ID and version. Renew before the lease expires (60?3,600 seconds), or use `block`, `complete`, `release` or `handoff` with that version. Handoff additionally takes `target_session_id`. Renewals and claims reject stale accepted revisions, incomplete dependencies and overlapping live reservations. After expiry another session may explicitly reclaim a task using its current version.

Reservations are enforced by Relay operations. They do not intercept every shell command or lock files edited outside Relay. Agents must use the workflow for coordination. Expiry is displayed explicitly and is not proof that a human stopped editing.

## Transfer code as bytes

Use `relay_artifact` with `operation: "export"`, exact relative `paths`, `share: true`, and optionally `target_session_id`. `share` records the invoking agent's assertion that its local user authorized sharing these files; a peer message cannot provide that authorization. No additional model is used to reproduce source text.

- Baseline defaults to the exporting checkout's HEAD, capturing working-tree changes. Pass `base_ref` as a full existing commit hash to include committed changes relative to that revision.
- New/untracked files require `allow_untracked: true` and explicit selection. Deleted files are represented by a deletion record.
- Credentials, environment files, private agent state, databases and symlinks are excluded. Credential-pattern checks are best effort, not comprehensive secret classification.
- Limits: 50 files, 1 MB total selected file content, 2 MB encoded bundle, 24,000-character upload chunks, 20 MB encoded artifacts and 100 artifact records per project. These bounded SQL artifacts are for source changes, not large binaries or build outputs.
- Upload chunks are idempotent and the complete bundle hash must match before sealing. Interrupted exports can be retried from the unchanged checkout. `abort` removes an unsealed upload owned by the exporter/project owner.
- `receive` verifies bundle and file hashes and saves the bundle under local `.relay/next/artifacts`. It never applies files.
- `read` takes `artifact_id`, `path`, `offset` and `limit` to inspect a bounded range. No code bytes enter model context until requested.

## Prepare, validate, accept

`relay_integration` with `operation: "prepare"` and `artifact_id` requires a clean receiving checkout. Commit or otherwise preserve the installer's `.gitignore` adjustment and any unrelated local edits first. Every selected file must match the artifact's baseline hash. Conflicts stop the operation; Relay does not invent a merge resolution. Preparation creates a detached worktree under `.relay/next/integrations` and leaves the original checkout untouched.

Review that worktree, then call `relay_integration` with `operation: "validate"`, its `id` and an explicit local executable/argument array:

```json
{"operation":"validate","session_id":"YOUR_SESSION","id":"PLAN_ID","command":["node","--test","test/auth.test.js"],"timeout_ms":60000}
```

Validation runs code in the isolated worktree using your local permissions. Choose a meaningful project-specific command under the user's authorization. Dependencies are not automatically installed. On Windows use `node` and a script path for npm tooling where a `.cmd` file cannot be spawned directly without a shell. A passing exit code is evidence only for the chosen command. Timeouts or changes to the prepared tree invalidate acceptance.

Acceptance is deliberately a separate local CLI operation:

```sh
relay-next accept --id PLAN_ID --session YOUR_SESSION --approve
```

Run it only with developer authorization to integrate. It requires the original checkout to remain clean at the prepared HEAD, the validated worktree to remain unchanged and no conflicting task reservation. Relay takes a 120-second project integration reservation, commits the prepared tree as `Relay Integration`, fast-forwards the local branch, and publishes the accepted revision with validation provenance. It does not push to GitHub. The service records the integrating member's test evidence; it does not claim to have run those tests itself.

If publication fails after the local fast-forward, the local plan retains its accepted commit; rerun acceptance to retry publication. A conflicting shared revision is surfaced for reconciliation. Never reset a checkout to hide such a conflict. Other developers obtain the accepted commit through the team's Git workflow before claiming alignment; an artifact receipt alone does not synchronize Git history.

## Observe and retain

`relay-next metrics` / `relay_metrics` report native offers, tool/hook output sizes and replay/snapshot payloads as characters and UTF-8 bytes. These are not tokenizer counts, provider bills, or proof of model processing. Native queue acceptance and actual agent acknowledgement remain distinct.

`relay-next backup` creates a local project evidence/artifact archive plus SHA-256 under `.relay/next/backups`. It contains private project data but excludes provider and membership tokens. It is a paginated export with a final event cursor, not an atomic service-wide backup or a credential recovery image. Protect it as private data.

`relay-next prune --session YOUR_SESSION --backup ARCHIVE --days 7 --approve` verifies the archive before pruning old unreferenced artifacts and exact archived completed/released tasks. Referenced artifacts, unresolved directed artifact delivery, current integration and dependency references are preserved. Seven days is the default review threshold, not automatic deletion. Event history remains retained. Copying an archive to separate protected storage and testing recovery are operator responsibilities; automated restore is not provided.

## Verification limits

Automated fixtures exercise two checkouts, exact byte transfer, clean/stale/conflicting integration, validation failures and tampering, duplicate replies, oversized retrieval, batched receipts, task ownership/expiry, isolation and backup integrity. A local Cloudflare emulator checks the protocol against SQLite Durable Objects. Physical two-computer operation, model token savings and provider-specific native delivery after this upgrade still require acceptance evidence. No model-credit test is part of ordinary CI.
