# Nox AI

Nox AI is a local-first chat application with a browser interface, a Node.js
backend, a command-line client, and a VS Code workspace integration. It connects
to OpenAI-compatible model servers and stores conversations on this computer.
Nox AI does not install model runtimes or download model weights.

## Requirements

- Node.js 20 or later and npm for development.
- A compatible model provider for chat. Ollama, LM Studio, and llama.cpp can
  expose compatible APIs; Nox AI starts without one and reports the provider as
  disconnected until it is configured.
- The planned Windows release targets Windows 10 or later on x64 and requires
  the Microsoft Visual C++ 2015–2022 x64 runtime. The installer checks for it.

## Build and run from source

In PowerShell at the repository root:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
npm.cmd run nox
```

The default `nox` command starts or reuses the backend and opens the UI at
`http://127.0.0.1:4317`. The backend binds to loopback by default. To suppress
automatic browser launching, set `$env:NOX_NO_BROWSER = '1'`. After building,
use `npm.cmd start`, `npm.cmd run status`, and `npm.cmd stop` for lifecycle
management. `npm.cmd run dev` builds and starts the service.

The CLI also supports:

```powershell
npm.cmd run nox -- --help
npm.cmd run nox -- doctor
npm.cmd run nox -- models
npm.cmd run nox -- ask "Explain what a local model server does"
npm.cmd run nox -- chat
```

The app's default provider is Ollama at `http://localhost:11434`, model
`llama3.1`. These are defaults only; Nox AI does not claim that Ollama or the
model is installed. Open **Settings** in the UI to select a provider, discover
available models, and verify a chosen model by sending one short test prompt.
This verification performs actual inference against the configured provider;
automated tests use mocks and do not prove real inference.

For Ollama, install it from its official source, then explicitly choose whether
to download a model (for example, `ollama pull llama3.2`). LM Studio and llama.cpp
are also supported when their OpenAI-compatible server APIs are running. Nox AI
never silently selects a cloud provider or downloads model weights. Requests to
non-loopback providers require explicit remote opt-in in UI settings or the
CLI's `--allow-remote` option. Ollama model IDs ending in `:cloud` also require
that CLI opt-in even when the server is local.

Environment overrides include `NOX_PROVIDER`, `NOX_BASE_URL`, `NOX_MODEL`,
`NOX_API_KEY`, `NOX_PORT`, and `NOX_DATA_DIR`. API keys are not written to the
settings file. By default, app data is kept in `%LOCALAPPDATA%\\Nox AI` on
Windows and `~/.nox-ai` elsewhere. Back up this directory to preserve local
history and settings.

## Windows installer and release status

The repository includes a per-user installer (`install.ps1`), launcher
(`nox.cmd`), safe uninstaller, and a release packaging script. The installer
expects a published stable GitHub Release with a versioned Windows ZIP and
`SHA256SUMS.txt`; it verifies the checksum before extracting, checks the
archive paths, and does not remove user data during upgrades or uninstall.
Release packaging stages an explicit runtime allowlist and verifies the
official Node.js ZIP against Node.js' published SHA-256 manifest.

**A one-command hosted installation is not available yet.** No release assets
have been published for this repository, so the installer currently fails
closed rather than installing an unverified or missing package. Do not use a
hosted installer command until a stable release and its assets have been
published and the end-to-end installation has been verified. This project does
not currently provide code-signed artifacts.

After release assets exist, maintainers can build and inspect them on Windows
x64 with Node.js/npm and PowerShell:

```powershell
.\scripts\package-release.ps1 -Version 0.1.0
```

The package script builds, typechecks, tests, and writes a versioned ZIP plus
`artifacts\SHA256SUMS.txt`; it does not publish a release. Installer execution,
upgrade, PATH persistence, and uninstall still require end-to-end verification
on Windows. Do not bypass PowerShell execution policy to force those checks.

## VS Code

Open the repository in VS Code and press `F5` to launch the Extension
Development Host. Use the Command Palette commands **Nox AI: Chat**, **Nox AI:
Explain Workspace**, or **Nox AI: Validate Workspace**.

The current **Explain Workspace** command reports a short workspace scan
summary; it does not yet generate a model-based explanation.

See [SECURITY.md](SECURITY.md) for security boundaries and
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for validation status and
release blockers.
