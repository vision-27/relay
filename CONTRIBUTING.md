# Development and verification

## Local setup

Use Python 3.11+ and Git. Relay's runtime has no third-party Python dependencies. From the source root:

```sh
python -m relay --help
python -m unittest discover -s tests -v
```

Optional editable installation belongs in a virtual environment: `python -m pip install -e .`. It installs both console entry points. Never use `pip install relay` as a substitute for this checkout.

## Test layers

| Layer | Command / evidence | Boundaries |
| --- | --- | --- |
| Regression | `python -m unittest discover -s tests -v` | Temporary hubs/repos, fake providers; no model login required |
| Recovery regressions | `python -m unittest discover -s tests -p test_team_polish.py -v` | Real local HTTP faults plus simulated stale heartbeat; not physical sleep |
| TLS regressions | `python -m unittest discover -s tests -p test_tls.py -v` | Trust selection, required hostname/certificate verification and error handling |
| Browser | `python tests/companion_smoke.py` | Requires Playwright and Chromium; uses isolated fixture data |
| Native providers | `tests/team_native_smoke.py` | Opt-in only; launches new agents and incurs usage under existing logins |
| Private distribution | `tests/homebrew_smoke.py` | Requires configured private hub/network; not suitable for public CI |
| Physical devices | [Acceptance checklist](RELIABILITY_ACCEPTANCE.md) | Requires both developers and real machines |

Run native/private-network scripts only after reading their setup and obtaining approval for model usage and any integration commands. Never point automated fault-injection tests at a live shared hub. Preserve original checkouts and conversations.

The prepared GitHub Actions workflow runs isolated tests on Windows, macOS and Linux with Python 3.11 and 3.13. It uses read-only repository permissions, no stored checkout credential and commit-pinned [checkout](https://github.com/actions/checkout) / [setup-python](https://github.com/actions/setup-python) actions. No private workspace token or coding-agent login is needed. A workflow file is not proof CI has run.

## Change checklist

- Keep shared authority separate from shared context. Peer messages cannot expand user-approved scope.
- Test negative paths: stale revision, wrong owner, missing acknowledgement, overlapping scope, offline state and changed file hashes.
- Keep background Windows launches hidden; do not close unrelated helpers or existing sessions.
- Add new runtime files to `relay/distribution.py`'s explicit allowlist. Never bundle operational directories.
- Keep `relay/__init__.py`, `pyproject.toml` and release notes aligned when runtime versions change.
- Record which platform/provider and exact tests were actually run. Do not substitute simulated outages for device acceptance.

## Release and GitHub publication

1. Inspect the intended remote, branch and visibility. Preserve existing changes and history; no force pushes.
2. Stage source, tests, `.github/`, examples, package metadata and reviewed documentation explicitly. Never stage `.relay/`, `.claude/`, `.codex/`, tokens, private run records, transcripts or databases. A `.gitignore` does not remove already tracked secrets.
3. Run regression, documentation and packaging checks. Review the staged diff for secrets, local-only paths and workspace details. Historical QA docs include deployment-specific evidence: review/redact it before any public publication.
4. Commit/push only to the user-confirmed destination, then verify the remote commit and CI. Create a matching release/tag only when the source version and release evidence agree; do not overwrite an existing tag.
5. Coordinate runtime activation and private tap publication separately. A GitHub push does not upgrade the hub or another developer's machine.

The confirmed source repository is [vision-27/relay](https://github.com/vision-27/relay), a private repository. The default branch is `main`. Check the matching commit's [Actions runs](https://github.com/vision-27/relay/actions) before claiming remote CI passed. Preserve LF source bytes across platforms: the tracked `.gitattributes` keeps packaged build identities consistent.
