# Relay efficiency audit

28 September 2026. Baseline: commit d476750. Research and local measurements only; no runtime changes or model calls were made for this audit.

## What currently consumes tokens

`relay_ask` queues a durable event and returns immediately. The connector and its network waits do not call a model. Native delivery supplies a question to the existing addressed session, which can trigger a model turn. That turn may process the receiving session's existing context, call acknowledgement/reply tools, and produce an answer. The answer is delivered to the asking session and may trigger another turn. Active sessions may incorporate messages into an existing turn; do not assume every message necessarily starts a separate model request.

Relay does not copy the sender's entire conversation. `adapters.ts:message` sends question/reply text, evidence, full Git metadata and receipt instructions. Cached input, uncached input, output and model reasoning must be measured separately; payload size alone is not a bill.

## Measurements

All figures below are JavaScript string lengths for these mostly ASCII fixtures, not tokenizer counts or billed usage. No project text was sent to a token-counting API.

### Synthetic fixtures through current runtime functions

- A 25-character question becomes a 657-character native message with zero changed files, 1,096 with 10 changed files, and 2,856 with 50 representative changed paths. UUID lengths, source metadata and safety/receipt instructions account for the overhead.
- Six 504-character decision records produce a 4,811-character readable context. The MCP result is 10,664 characters with no changed-file paths, or 23,858 with 50 paths per event. `relay_context` serializes both raw `events` and the rendered `text`.
- Keeping rendered text, event IDs and coverage metadata yields 5,278 characters: 51% and 78% smaller respectively. This is a proposed projection, not deployed behavior. Full paths, structured metadata and provenance must remain retrievable by ID.
- An allowed 8,000-character directed question is omitted entirely by the 7,000-character hook context budget. Reproduced with `context()` and a fake state. Oversized records need a labelled preview plus an exact retrieval path, not silent loss.
- Six tool definitions total 2,224 characters; shared MCP instructions total 720 characters. Actual tool-definition loading and caching are client controlled, so these are not necessarily paid on every request.

### Bounded local DA-Agent cache sample

One read-only snapshot contained 14 events: two questions, eleven replies and one observation. Question bodies totalled 1,115 characters; reply bodies totalled 59,691. The first question received one 833-character status answer. The second requested actual working-tree source for comparison and had ten replies totalling 58,858 characters, including an initial approval hold and numbered source chunks. These are intentional chunks, not established duplicate retries. The source author approved sharing according to the reply; Relay must preserve that authorization boundary for artifact transfers.

The corresponding cached snapshot contained three sessions and thirteen receipts (6,774 serialized characters). This sample is ongoing collaboration, not a representative cost benchmark. No provider billing or friend's private transcript was inspected.

## Priority 1: compact and correct model-visible output

1. Return one context representation with IDs, timestamps, source/revision/dirty status and coverage; fetch expanded details on demand.
2. Make status concise by default: session ID, name, task, activity timestamp/state and revision. Filter/page receipts instead of returning up to 500 with full session Git objects.
3. Use a compact native envelope with exact message/sender/recipient IDs, question/reply, relevant paths and minimal code provenance. Keep fingerprints and full dirty-file lists in storage. Do not compress away uncertainty or peer-content trust rules.
4. Use explicit per-call detail and response budgets. Never reject or truncate an important answer without a clear expansion path.
5. Add exact event retrieval and bounded range retrieval; make oversized messages visible through a preview. Apply the output budget to the final serialized tool response.
6. A successful substantive reply should satisfy the question's acknowledgement. The server already records an answered receipt; remove redundant model acknowledgement instructions for immediate replies. Retain separate acknowledgement for deferred work.

## Priority 2: transfer source as artifacts

Add explicit artifact export/import tools: selected paths or a patch, a manifest, byte lengths, content hashes, source session and Git revision/dirty state. Transfer bytes through authenticated project-scoped storage or an approved existing Git/artifact location; do not ask the source model to regenerate file contents as chat replies. Include untracked files only when explicitly selected. Exclude credentials and private runtime data. Transfers remain within the source user's sharing approval.

The receiver gets a short manifest and can inspect a diff summary, symbols or exact line ranges. Verify hashes on receipt, handle paths/symlinks safely and never apply a patch merely because it was received. Storage, retention and transfer costs remain separate from model costs. Review still requires model context for relevant code; byte transfer removes the source model's reproduction work and unnecessary blanket injection.

## Priority 3: avoid unnecessary agent turns

Read known facts from the synchronized local store first: current task, last update, recorded decisions and prior answers. Return source and age; stale/missing evidence must not impersonate a current owner answer. An explicit request to ask the owner still routes to the owner.

Allow compact summaries plus references, configurable detail and follow-up expansion. Coalesce routine progress updates at a bounded interval; deliver urgent changes and explicit questions promptly. Keep waiting event-driven; do not make agents poll status repeatedly. Separate progress, final answer and artifact availability so a multi-part transfer does not cause a fresh model interruption per chunk.

## Priority 4: deduplication and context lifecycle

Native delivery and hook inclusion use different state: `supplied` is not updated by `relay_ack`, and `context()` does not filter answered receipts. A native-delivered question can therefore reappear through hooks. `SessionStart` intentionally includes seen records, and explicit context reads include them too. Evaluate and reproduce these paths before changing them.

Use stable event IDs and a per-session context epoch. Within an epoch avoid repeated injection of acknowledged messages; after compaction/resume restore a bounded current summary when needed. Queue acceptance is still not confirmed delivery, and uncertain delivery must retain a safe recovery path. Never deduplicate intentionally different updates or suppress an explicit request to reread evidence.

## Other efficiency work

- Hooks currently recompute Git state frequently and context generation can run ancestry checks per event. Memoize within a call and by checked-out HEAD; capture dirty state accurately at publication.
- Full snapshots and event reconciliation every 30 seconds consume service requests but no model tokens. At steady idle, two GETs per reconciliation are roughly 5,760 requests/day/connector, before reconnects and writes. Measure actual request counts before changing the recovery interval.
- Keep local FTS retrieval first; add embeddings or an LLM summarizer only if retrieval evaluations justify their recurring cost and complexity.
- Bound accumulated history with a retention/archive policy that preserves unresolved messages and referenced evidence.

## Measurement and acceptance gates

Record payload characters/bytes and model-specific token estimates at native delivery, hook injection and MCP result boundaries. Log event IDs, sizes and reasons rather than raw content. Count native offers, hook inclusions, explicit receipts, duplicate inclusions and model turns when observable. Provider usage remains authoritative for cached/uncached input, output and reasoning. Do not claim incremental dollar savings from these character counts.

Evaluate short status questions, complex rationale, repeated reads, 8,000-character messages, large code transfers, stale evidence, supersession, reconnect ambiguity and compaction/resume. Assert source/session IDs, revision and dirty state, exact artifact bytes, delivery recovery and relevant evidence survive optimization. Use no-model fixtures first; obtain approval before paid native comparisons. Report quality and delivery failures alongside savings.

Suggested order: output projections and oversize retrieval; artifact transfer; fewer wakeups; then lifecycle deduplication and measured retrieval improvements.

## Primary research

- [Claude Code cost guidance](https://code.claude.com/docs/en/costs): full-conversation input, cached usage, cross-session messages, context inspection and local preprocessing.
- [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents): concise/detailed outputs, meaningful selection, pagination and evaluation.
- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting): model-specific estimates; counts differ by tokenizer and are not final billed usage.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): prefix reuse and model-dependent cache behavior. Relay's queue/MCP layer does not directly control the host client's API cache configuration.
