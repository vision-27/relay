# Upgrades and recovery

## Upgrade an existing installation

Finish active goals first. If work is unfinished, record `/status` and the private run/candidate paths before stopping; closing a controller does not provide automatic crash takeover. Do not erase its run records or release ownership just to remove a warning.

On macOS/Homebrew, use the normal shell (not a running Relay input prompt):

```bash
brew update && brew upgrade relay/workspace/relay-workspace
brew list --versions relay-workspace
```

The current application release is **0.6.2**, private formula revision **12**, including the Windows certificate-chain fix. Quit/reopen the local Relay app and launch fresh team sessions. A browser refresh cannot update a running Python process. Reconnect the coding client's MCP only if using the separate existing-conversation connector; team mode manages its own tools.

For source installs, update from the confirmed repository/release after preserving local edits. Start commands from the folder containing `relay/`, using `python -m relay`; Python 3.11+ is required. Never install the unrelated PyPI package named `relay`.

On the host, coordinate the interruption, use SQLite's backup API, publish the immutable source package/private tap and restart only the identified Relay services. Verify `/health`, local companion release, member records, saved connections and checksum before handing back the workspace. Do not restart Codex/wmux or discard reservations as part of a package update.

## Diagnose connection errors

1. Check the URL. A teammate must use the shared HTTPS address; `localhost` points at their own machine.
2. Ensure the hub computer is awake, signed in and running Relay. Both computers must retain access to the private network.
3. Check the public, read-only health endpoint using your actual workspace URL:

   ```bash
   curl --fail --show-error --max-time 15 https://YOUR_TEAM_HUB/health
   ```

   In Windows PowerShell, use `curl.exe`. Do not disable certificate verification. A successful health response proves reachability/version, not authentication, loaded agent tools or completed work.

4. In the existing team terminal, use `/status`. Brief network errors should show blocked edits followed by automatic reconnection to the same session. Leave the terminal open; do not start a duplicate controller.
5. If explicitly paused or stopped on an authorization/provider error, resolve the cause and use `/resume`. Automatic reconnection must not undo a deliberate pause.

## Recovery boundaries

| Symptom | Safe action |
| --- | --- |
| Brief outage or client sleep/wake | Wait for a fresh heartbeat/reconnection; inspect `/status` |
| Connected again but interrupted agent work has not progressed | Inspect state, then explicit `/pause` and `/resume` to reconcile the current assignment |
| Interrupted integration test | Inspect retained candidate and test receipt; `/retry TASK_ID` explicitly requests another check |
| Stale plan/review assignment | Fetch current hub status; do not guess revisions or keep retrying a stale review |
| Missing token or expired approval | Use your own workspace login/approval; never share your teammate's token |
| HTTPS certificate verification failed | Check device clock and hub certificate; update Relay for the Windows cached-intermediate fix. Never disable verification |
| Terminal/process already exited | Preserve the private run and candidate branch; reconcile manually before any new controller |
| Goal complete but agent prose says “in review” | Trust the hub's latest task status and integration receipts |

Network retry is not model-turn replay. Automatic takeover after controller-process death remains unsupported. Do not delete private state, force-reset worktrees, steal ownership, or start duplicate controllers to bypass a gate.

## Finished work

The final result is on the dedicated local integration branch printed by the goal owner. Inspect the branch and test receipts, then choose whether to publish or merge using normal Git tools. Nothing automatically appears on your current branch or your teammate's checkout. Use `/quit` once finished; the result is retained.

## Before sharing diagnostics

Share only release/build, goal/task/session IDs, timestamps, sanitized errors and exit codes. Do not attach connection files, tokens, source conversations, hub databases or unrestricted process command lines. The private network hostname and local repository paths may also be sensitive.
