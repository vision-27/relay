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

Inspect the remote, branch and repository visibility. Stage reviewed source and documentation explicitly, inspect the staged diff for credentials and run the checks above. Commit and push only with user authorization. Preserve Git history; do not force-push. Verify the remote commit and its Actions results before claiming CI passed.

A source push does not deploy a Worker or upgrade another developer's installation. Deployment and runtime activation are separate actions. Legacy source is available in Git history.
