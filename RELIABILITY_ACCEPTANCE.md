# Two-person daily-use acceptance — 0.6.2

Current evidence: two physical Windows–Mac team trials completed on 0.6.0. The 0.6.2 hub/Windows companion and private Homebrew package are updated. The new release's physical Mac upgrade, network interruption and sleep/wake checks remain **untested**, not failed or passed by inference.

## Prepare both computers

1. Finish current runs and preserve results. Upgrade both clients; on Mac use `brew update && brew upgrade relay/workspace/relay-workspace`, then `brew list --versions relay-workspace`.
2. Quit/reopen the companion and start fresh team terminals. Confirm the hub's `/health` version/build matches the installed release shown by Relay's connection check. Current build: `81981d8e54b989d2def92ecd3f34cd2e00352ce66ea5cca5661890aa5dc0cbdf`.
3. Use checkouts of the same Git repository at a compatible committed revision. Confirm the folder at each launch; do not alter global roots or reuse an unrelated conversation.
4. Keep the hub awake and the private network connected. Agree when it is safe for the client Mac to disconnect or sleep; never interrupt unrelated work without consent.

## A. Fresh end-to-end team goal

Use a unique, previously absent directory such as `relay-acceptance-YYYYMMDD-RUN`. The goal must authorize exactly three new files (`alpha.txt`, `beta.txt`, `gamma.txt`) containing the five bytes `ready`, no newline. Require three disjoint tasks, independent review, no other edits/settings, and no push.

The owner starts `relay-workspace team --url https://YOUR_TEAM_HUB`; Von joins the displayed ID using the following **single line in his normal shell**:

```bash
relay-workspace team --agent claude --goal GOAL_ID --url https://YOUR_TEAM_HUB
```

Press Enter at “Anything to add.” Both approve automatic worktrees/helpers if testing them. The owner approves an incremental check that verifies every present trial artifact, then independently checks **all three files are present** after integration. A test that only validates present files is not a final completeness check.

For final verification, run this in the retained integration checkout, replacing the directory name:

```sh
python -c "from pathlib import Path; p=Path('relay-acceptance-YYYYMMDD-RUN'); expected={'alpha.txt','beta.txt','gamma.txt'}; assert {f.name for f in p.iterdir()}==expected; assert all((p/n).read_bytes()==b'ready' for n in expected); print('All three exact artifacts verified')"
```

Record the goal ID, each session's platform/role, task IDs, independent reviewers, test exit codes and final integration commit. Verify the original working folders and conversations are untouched. A matching hash is evidence of bytes, not proof of integration by itself.

## B. Physical interruption and sleep/wake

Use an active disposable trial, not production feature work. Keep the **same** Relay process running on the Mac throughout each check.

1. Record `/status`, the goal ID and Mac session ID. Briefly disconnect the Mac from the private network for at least 30 seconds while the hub stays reachable from Windows.
2. Observe that guarded Mac edits are blocked and reservations remain held. Do not release or reassign them merely because the Mac is offline.
3. Reconnect. Expect automatic connectivity recovery to the same session/controller, current assignments and no duplicate model turn or second helper caused by transport retry. Record elapsed recovery time and `/status`.
4. With consent, sleep the Mac for at least 30 seconds; wake it and repeat the identity, heartbeat, ownership and no-duplicate checks. A simulated stale timestamp does not satisfy this step.
5. Explicitly `/pause`, disconnect/reconnect or sleep/wake, and verify the session stays paused. Only developer `/resume` may resume it.
6. If a model turn or integration test was interrupted, inspect its current state first. Use the documented explicit recovery controls; do not score connectivity recovery as automatic completion of interrupted work.

Do not disable TLS, delete run records or launch duplicate controllers to make the trial pass. If reconnect fails, record sanitized timestamps/error/status and leave ownership intact.

## C. Conflict and dependency trials

- In a disposable repository/goal, attempt overlapping declared file/interface work from the two PCs. The second started reservation must be blocked; no last-writer-wins overwrite is acceptable.
- Test a dependency chain in isolated checkouts: dependent work must wait and receive the completed prerequisite artifact before editing. Review and test the integrated result.
- Test a stale plan review after a requirement revision. It must be rejected until the current review assignment is issued.

## D. Existing-conversation sharing (separate mode)

If using the browser companion, connect only approved conversations and explicitly load their advisory MCP tools. Ask A's source agent a grounded question from B, then reverse the direction. Record question/source IDs and returned evidence, not tokens/transcript dumps. Registration alone is not successful tool use.

Pause sharing, quit/reopen the companion and verify it stays paused. With consent, test per-user login startup on each OS. Managed foreground team terminals are not automatically restarted by companion login startup.

## Evidence ledger

| Check | Required result | Current 0.6.2 physical status |
| --- | --- | --- |
| Mac upgrade and matching release | Installed 0.6.2 and fresh process | Untested |
| Three-file team goal | Independent reviews, receipts, all three final bytes | Untested |
| Network interruption | Same controller, blocked offline edits, retained ownership | Untested |
| Mac sleep/wake | Fresh heartbeat before edits, no duplicate work | Untested |
| Explicit pause | Remains paused after reconnect | Untested |
| Overlap/dependency workflow | Gates and integrated result correct on both PCs | Untested |

Local regressions and prior-version physical trials are recorded separately in [POLISH_QA.md](POLISH_QA.md). Record each item as passed, failed or untested with evidence. Do not declare production readiness while required checks remain untested.
