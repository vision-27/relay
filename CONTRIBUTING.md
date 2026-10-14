# Development and verification

Use Node.js 22.13+ and Git. The TypeScript implementation lives in `next/`.

```sh
npm ci
npm run check
npm test
npm run demo
npm pack --dry-run
```

The automated suite and demo use isolated fixtures without model credentials. CI runs these checks on Windows, macOS and Linux with Node 22. A workflow file alone is not evidence of a successful run.

## Integration checks

See [setup](next/README.md) and [verification](next/VERIFICATION.md). `npm run test:worker` targets a separately started local Cloudflare emulator. Hosted checks require an explicitly selected service and operator credentials and create an isolated fixture project. Never run fault injection against a live shared project.

`npm run test:native` launches a disposable coding session and consumes model usage. Obtain approval before running it, including the spend and time limits. Preserve existing conversations and checkouts. Native acceptance, physical device acceptance and simulated adapters are separate evidence.

## Change checklist

- Peer context cannot expand user-approved scope. Preserve source, session and Git provenance.
- Exercise wrong recipients, stale revisions, offline recovery, deduplication and ambiguous delivery. Provider acceptance is not a model acknowledgement.
- Canonicalize trusted temporary roots across platforms; reject symlinked installation targets. Close SQLite handles before cleanup on Windows.
- Keep background Windows helpers hidden and preserve unrelated running sessions.
- Keep runtime package contents explicit in `package.json`. Exclude credentials, operational directories, transcripts and databases.
- Record the exact platforms and checks actually exercised.

## Publication

Build distributable files with `npm run package:release` and
`npm run build:desktop`. Outputs and SHA-256 checksums go to `.relay/releases/`.
The npm archive contains compiled runtime code and user guides; local state,
credentials, model transcripts, tests, and development dependencies are excluded.

`relay setup` defaults to hosted group onboarding. The older connector setup is
available through `relay setup --legacy-network`; legacy invitation codes are
also recognized automatically.

For a release, update `package.json`, its lockfile, `next/core/version.ts`, the
README/setup commands, and `.github/RELEASE_NOTES.md` together. Push an annotated
`vVERSION` tag only after review. The release workflow requires the Windows,
macOS, and Linux checks before creating a GitHub prerelease and attaching builds.
Release creation preserves the repository's visibility. The npm registry is not
configured for publishing; the package remains `private: true` to prevent an
accidental registry release. No open-source license is granted by packaging it.

Inspect the remote, branch and repository visibility. Stage reviewed source and documentation explicitly, inspect the staged diff for credentials and run the checks above. Commit and push only with user authorization. Preserve Git history; do not force-push. Verify the remote commit and its Actions results before claiming CI passed.

A source push does not deploy a Worker or upgrade another developer's installation. Deployment and runtime activation are separate actions. Legacy source is available in Git history.
