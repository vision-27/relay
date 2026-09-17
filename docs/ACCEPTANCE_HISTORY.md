# Historical advisory-connector acceptance checklist

This checklist predates managed team automation. Use [the current acceptance checklist](../RELIABILITY_ACCEPTANCE.md) for the latest release. The implementation limits below are historical, not the current product feature list.

Status: implementation and isolated Windows tests are not a completed physical two-PC acceptance run.

## Once on each computer

1. Use the same Git project on both PCs. Different features/branches are fine; a matching Relay project label alone does not prove repository identity.
2. Install the current private release. Homebrew: `brew update && brew upgrade relay/workspace/relay-workspace`.
3. Quit/reopen Relay. Reconnect Relay MCP in the coding client so it loads the updated connector. Do not reinstall unrelated MCP servers or copy tokens.
4. In Relay Settings, opt into login startup. Only previously approved conversations resume; pause remains pause.
5. Open Team workspace, choose the intended project, and select Check team connection. Resolve each displayed mismatch. Ask each working agent to read Relay team context to verify its tools.

## Physical round trip — both directions required

Record timestamps and question IDs, not private transcript dumps or access tokens.

- On PC A, complete a small real feature turn and wait for its shared context summary.
- On PC B, ask its working agent to use Relay to explain one concrete implementation decision from A, with a code/source reference and explicit uncertainty. Confirm the recorded answer matches A's work.
- Repeat B → A. An answer generated from unrelated context or supplied manually by a developer does not pass the context-transfer check.
- Briefly disconnect B from the network. Queue a question for B from A. Reconnect B: the same question should eventually receive one recorded answer, without creating another connection or losing pending activity.
- Pause B, quit/reopen Relay on B, and verify it remains paused. Resume explicitly.
- With the hub awake, sleep/wake the client PC and verify sync recovers. Then test sign-out/sign-in on each PC at an agreed time. No reboot or logoff is performed automatically by QA.
- Confirm build checks still match after a package upgrade, and previously shared history remains available.

## Pass criteria

Both physical PCs are on the same published build; both working coding agents have executed a real Relay tool call; both directions return source-grounded context; pending activity survives interruption; pause and quit are respected; login startup has been observed on Windows and macOS. If any item remains untested, record it as untested rather than passing the milestone.

## Implementation limits

Login startup is per-user, not availability before login. The hub laptop must stay awake. An unresponsive-but-running process is reported rather than forcibly killed. This release does not enforce coding edit gates, wake a working peer agent, or merge code. Secret filtering is best-effort; selected conversation consent remains required.

Platform references: [Windows Run entries](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys), [macOS user agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [Linux desktop autostart](https://specifications.freedesktop.org/autostart/0.5/).
