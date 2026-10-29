# AG-Wormhole Project Directives & Rules

## 1. Documentation & Language Policy
- **README Language**: The project `README.md` MUST be written and maintained strictly in **English**. (This overrides any general default for this repository).
- **Changelog Language**: `CHANGELOG.md` MUST be written and maintained strictly in **English**.
- **Code & Inline Comments**: All source code, configuration files, test suites, commit messages, and inline documentation MUST be in **English**.
- **User Dialogue**: Continue communicating with the user in **Simplified Chinese** (简体中文) while generating all repository files, code, and documentation in **English**.

## 2. High-Availability & Anti-Disconnect Standards
- Always preserve SSH Keepalive directives (`ServerAliveInterval 15`, `ServerAliveCountMax 3`, `TCPKeepAlive yes`, `ConnectTimeout 15`, `ConnectionAttempts 3`, `StreamLocalBindUnlink yes`).
- Never introduce breaking changes to the `TunnelWatchdog` or `Provisioner.reclaimPort` self-healing mechanisms.

