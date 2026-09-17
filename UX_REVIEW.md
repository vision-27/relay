# Relay UX review — 0.6.2

## 0.6.2 follow-up

Re-ran all 44 headless browser checks successfully and inspected the 390px completion screenshot. Runtime TLS failures now distinguish certificate verification problems from generic hub unavailability; verification is never disabled. The README now starts with the two developer workflows, with separate architecture, upgrades/recovery, security, contribution and release guides. The physical acceptance checklist requires all final artifacts, not only correctness of whichever files happen to exist. Local documentation links and release metadata are tested. GitHub publication and updated physical Mac acceptance remain pending; these are not a new first-time-user study.

## Follow-up from the physical Windows/Mac trials — 2026-09-16

Two supervised physical-PC runs completed on 0.6.0, including a successful manual reconnection. They also exposed stale cross-goal messages, misleading agent prose, accidental shell commands entered as requirements, and network pauses. These findings informed the 0.6.1 candidate; they are not physical-Mac verification of the new build.

The candidate passed **44 browser checks** with fixture data. Visually inspected the 390px completion screen: no horizontal overflow, no join action for completed goals, no stale planning label, a persistent start-new-goal path, and explicit instructions for reviewing the retained branch and closing team terminals. Paused/offline workers have recovery guidance without claiming that finished work failed. The Sites skill informed preserving the existing working surface and testing meaningful states rather than redesigning the product.

The terminal now distinguishes shell commands from requirements, prints authoritative hub progress, and suppresses completed-goal wakeups. Transient connection retries do not replay model work or override explicit pauses. Detailed evidence and remaining limitations: [POLISH_QA.md](POLISH_QA.md).

**Release state:** shared hub and Windows companion activated on 0.6.1; private Homebrew revision 11 published. Von's Mac upgrade and a fresh physical acceptance run remain pending. No claim of zero-touch production readiness or a first-time-user study.

## Previous 0.6.0 review

## Verdict

The two-person workflow is clearer and the automated path is now functional. It is still a developer preview, not evidence that an unfamiliar team can use it without help. Browser QA was an automated walkthrough with fixture data; native-agent QA used real agents in isolated checkouts. Neither substitutes for a moderated first-time-user study or the physical Windows/Mac acceptance trial.

## Findings addressed

| Friction | Change |
| --- | --- |
| Unclear difference between sharing old context and starting working agents | Getting-started guide separates the three modes; empty Team workspace explains team coding |
| Users expected to select an existing conversation for team work | Explicit no-session-picker/no-extra-MCP guidance |
| Raw JSON in `/status` | Readable goal/task progress, integration errors and next actions |
| Duplicate old/new coordination panels and contradictory status labels | Legacy advisory sessions collapse below shared goals; failed checks explicitly say they need attention |
| Join command omitted the hub address, risking localhost confusion | Platform-specific copyable command includes the hub's configured team URL |
| Manual-only integration text contradicted automatic mode | Shared goal displays the approved test command and dedicated integration branch |
| Test failure gave no recovery path | Task shows the error and `/retry` guidance; test failures can return bounded agent corrections |
| Users unsure where code was written | Startup prints isolated checkout/integration branch; guide explicitly preserves original/dirty files |
| Helper usage and test execution could be surprising | Per-run explicit consent, one helper limit, exact commands, OS-privilege warning |

## Verified

38 browser checks passed, including sign-in persistence, consent/back/cancel, empty/filtered conversation lists, offline recovery, shared context, escaped activity, join guidance, automatic checks/failure rendering, and 390px mobile overflow checks. The mobile screenshot was inspected. Test data and simulated model responses are explicitly marked in the QA report; no real conversations or identities were connected by browser tests.

Real installed Codex and Claude agents, plus a controller-spawned Codex helper, completed a three-task plan through independent review, guarded writes, tests and automatic Git merges. The original checkouts and existing conversations were untouched. See `.relay/team-automation-native-verification.json` and `.relay/companion-qa/verification.json`.

## Remaining friction, stated plainly

- Working sessions still need one terminal per PC; the browser monitors them but does not launch or control them. No helper opens an extra terminal.
- The owner must know the project's test command and, if needed, its dependency setup command. No reliable test command can be inferred from every repository.
- Starting from committed HEAD deliberately excludes private/uncommitted work. This must remain visible in onboarding.
- Branch publication and merging into `main` stay outside this automation. Integrated work lives on a dedicated local Relay branch.
- A crashed integration controller cannot currently be resumed from a new process; preserved state requires reconciliation. The app must not claim this is automatic recovery.
- “Check team connection” still measures the earlier sharing/MCP workflow. It is not proof that team-mode workers or automatic integration are ready; use Shared goals and the live terminals for that mode.
- Physical Windows/Mac sleep/wake, connectivity interruptions during merge, and two first-time developers following only the guide remain acceptance work.

## Suggested human acceptance script

Give each developer only GETTING_STARTED.md. Ask them to join the same repository/goal, approve their limits, complete one real feature, find its test result and integration branch, pause/resume, and explain what is and is not pushed. Record where assistance was needed and whether either person mistook sharing status for coding readiness. Do not score ease of use from HTTP success or automated checks alone.
