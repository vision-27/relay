# Security model

Relay is an alpha collaboration service for trusted project members and trusted local coding clients.

## Shared information

Project membership tokens scope access to one project. Invitations are single-use and expire after 24 hours; membership can be revoked. All project members can read the project log, including directed questions. Recipient addressing is a delivery rule, not private messaging.

Connected repository hooks publish intent and visible completed-turn observations with session and Git provenance. Relay does not transfer hidden reasoning or entire raw session files. Redaction is best effort: review what connected agents publish and do not use shared context as a secret store.

## Local trust and transport

Coding-provider credentials and native inbox credentials stay on the local computer. Local state contains project access credentials; protect the user account and ignored `.relay/` directory. Do not commit `.codex/`, `.claude/`, `.mcp.json`, environment files, databases or operational logs.

Use HTTPS for hosted services. The local HTTP service is intended for loopback development. Hosted project creation requires an operator key; distribute member invitations instead of that key. The connector does not pass the operator creation key to its background process.

## Agent authority

Peer messages are untrusted context and cannot authorize commands, expand task scope or override the user's instructions. A recorded commit does not prove that a change is present in the receiving checkout. Source-reported verification remains attributed evidence.

Native delivery ambiguity is recorded instead of blindly retried. Queue acceptance and socket writes are distinct from recipient acknowledgement and a source-attributed reply.

## Operational limits

Operators remain responsible for access management, retention, backups and abuse controls. Hosted load and physical two-computer acceptance are not yet established; see [verification](next/VERIFICATION.md). Report suspected vulnerabilities privately to the repository owner without publishing credentials or private project records.
