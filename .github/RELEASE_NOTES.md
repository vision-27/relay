Relay connects Claude Code and Codex conversations across workspaces.

### Install

- **Windows:** download the `RelaySetup-...-win32-x64.exe` asset and open it. The runtime is included.
- **npm:** run `npx --yes @platys/relay setup`, or `npm install --global @platys/relay` followed by `relay setup`. No archive or npm account is needed.
- **macOS/Linux:** desktop archives are built and smoke-tested in CI. Physical device/model acceptance is still pending.

Paste a fresh invitation link, check your name, and connect. Claude uses the **Claude with Relay** desktop shortcut; Codex needs a reopen and its normal hook trust review.

### Beta limits

Installers are unsigned. Claude retains its channel trust prompt and organization restrictions. Windows live messaging was tested; physical two-machine testing and complete visual setup QA are still pending. These artifacts contain no membership credentials. Repository access is required for desktop downloads from this private release; the public npm package needs no GitHub access.

See the repository README, setup guide, and troubleshooting guide for details. SHA-256 checksums are provided next to each artifact.
