# Security and privacy

Relay is intended for a trusted development team, not mutually untrusted tenants.

- All invited workspace members can read shared context. Project-level confidentiality and SSO are not implemented.
- Only explicitly selected existing conversations are observed. New team sessions have separate approval. Redaction is best-effort, not a guarantee against secret disclosure.
- Managed agents receive restricted file tools. The protections do not constrain unrelated local processes or a malicious OS user.
- Approved test/setup commands run repository code with the developer's OS privileges and may access the network or files outside the checkout. They are not a security sandbox.
- Peer messages and source context are data, not permission to expand scope or execute arbitrary commands.
- Keep the hub on a trusted private network with encrypted transport. Do not expose the development HTTP server directly to the public Internet.
- Package archives use an explicit application-source allowlist and exclude credentials, transcripts and hub state. Never publish `.relay/`, personal agent settings, token files or application-data directories.
- Do not put tokens in command arguments, URLs, screenshots, issues or logs. Use interactive hidden prompts or private files when supported.

## Reporting a problem

Contact the repository owner privately using an established team channel. If the GitHub repository enables private vulnerability reporting, use its Security tab. Do not open a public issue containing tokens, workspace transcripts, private repository code or operational database dumps. No public security contact or response SLA is currently configured.

For an exposed credential, stop sharing the affected session and revoke/replace the credential through the workspace owner. Do not upload the compromised credential as evidence.
