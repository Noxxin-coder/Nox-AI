# Security Policy

## Supported versions

This project is in active development. Security updates are handled on the current main branch.

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for a suspected vulnerability until a remediation path is agreed.

## Security protections included

- Secret redaction for common token and API key patterns.
- Workspace path validation to prevent directory traversal.
- Dangerous shell command detection.
- Patch validation to block unsafe file paths.
- Default folder exclusions for generated and dependency directories.
- The browser backend binds to `127.0.0.1`; it does not listen on LAN interfaces.
- The browser UI receives a per-instance random API token. API routes require that bearer token, browser origins must match the request host, and the HTML response uses a restrictive content security policy.
- CLI prompt, model-list, and connectivity requests to non-loopback endpoints are blocked unless `--allow-remote` is supplied. The UI separately requires an explicit remote-provider opt-in.
- Provider requests honor configured timeouts and cancellation. Provider response errors omit raw response bodies.
- The local settings file excludes API keys; optional credentials are read from `NOX_API_KEY`. Conversation records contain messages and timestamps, not provider credentials.
- Diagnostic logs record backend lifecycle and internal request failures without recording prompts or credentials.
- The Windows installer is designed for the current user, validates a versioned GitHub Release asset before extraction, and checks ZIP paths and expanded size. Release packages bundle the official Node.js runtime only after matching the official Node.js SHA-256 manifest.
- Installation and uninstallation do not require administrator elevation, change machine PATH, alter firewall settings, or remove conversation/settings data. The installer does not install a model runtime or download model weights.

## Current limitations

- The current runtime does not execute tools, shell commands, or model-generated patches. The project does not claim to provide a sandbox.
- API keys supplied by environment variables are available to processes running under the same user and are not stored in an operating-system credential vault.
- The VS Code chat command currently uses the default local provider configuration. It does not expose a remote-provider override.
- Localhost HTTP is not encrypted. The per-instance token is a defense against cross-origin browser control, not against other processes running as the same user or malware on the computer.
- Provider status and settings responses display only the endpoint scheme and host, not URL credentials, paths, or query parameters. Credentials embedded in a provider URL are rejected.
- Release checksums are not currently code-signed. SHA-256 detects download/corruption mismatches, but trusting a release still depends on HTTPS and the security of the GitHub repository/account. The installer source is included in this repository, but no stable release assets are published yet, so hosted installation is not currently available.

Report security issues privately. Do not send sensitive workspace data to a remote provider unless you have explicitly configured and approved that use.
