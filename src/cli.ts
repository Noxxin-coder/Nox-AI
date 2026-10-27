#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  DEFAULT_MODEL_CONFIG,
  parseStoredModelSettings,
  validateModelConfig,
  type ModelConfig,
  type StoredModelSettings,
} from './config.js';
import { describeEndpoint, requiresRemoteOptIn, sendChatMessage } from './runtime.js';
import { listProviderModels, type ChatMessage } from './providers/openaiCompatible.js';
import { resolveNoxDataDirectory } from './server.js';

export interface CliArguments {
  command: string;
  message: string;
  allowRemote: boolean;
}

interface BackendInstance {
  pid: number;
  port: number;
  token: string;
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateSpawnedBackend(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3000)) {
    return;
  }
  child.kill('SIGKILL');
  if (await waitForChildExit(child, 1000)) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Could not stop the Nox AI process started for this request (PID ${child.pid}); inspect it before starting again.`);
  }
}

function instanceFilePath(environment: Record<string, string | undefined>): string {
  return join(environment.NOX_DATA_DIR ?? resolveNoxDataDirectory(), 'backend-instance.json');
}

async function readBackendInstance(environment: Record<string, string | undefined>): Promise<BackendInstance | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(instanceFilePath(environment), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed) || typeof parsed.pid !== 'number'
      || !Number.isInteger(parsed.pid)
      || !('port' in parsed) || typeof parsed.port !== 'number'
      || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535
      || !('token' in parsed) || typeof parsed.token !== 'string') {
      throw new Error('Backend instance metadata is invalid. Inspect or move the backend-instance.json file before retrying.');
    }
    return { pid: parsed.pid, port: parsed.port, token: parsed.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function backendHealth(instance: BackendInstance): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return false;
    }
    const result = await response.json() as { service?: string };
    return result.service === 'nox-ai';
  } catch {
    return false;
  }
}

async function backendAuthenticated(instance: BackendInstance): Promise<boolean> {
  if (!await backendHealth(instance)) {
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/status`, {
      headers: { Authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string, environment: Record<string, string | undefined>): void {
  if (environment.NOX_NO_BROWSER === '1') {
    return;
  }
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const browser = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
  browser.once('error', (error) => {
    console.error(`Nox AI is running, but could not open a browser: ${error.message}`);
  });
  browser.unref();
}

async function startBackend(environment: Record<string, string | undefined>): Promise<void> {
  const existing = await readBackendInstance(environment);
  if (existing && await backendAuthenticated(existing)) {
    stdout.write(`Nox AI is already running at http://127.0.0.1:${existing.port}\n`);
    openBrowser(`http://127.0.0.1:${existing.port}`, environment);
    return;
  }
  if (existing && await backendHealth(existing)) {
    throw new Error('Port is served by an unrecognized local backend. Stop it or choose another NOX_PORT.');
  }

  const entrypoint = join(__dirname, 'server.js');
  if (!existsSync(entrypoint)) {
    throw new Error('The backend has not been built. Run npm run build, then retry.');
  }
  const dataDirectory = environment.NOX_DATA_DIR ?? resolveNoxDataDirectory();
  await mkdir(dataDirectory, { recursive: true });
  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: 'ignore',
    env: { ...environment, NOX_DATA_DIR: dataDirectory },
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 12000;
  try {
    while (Date.now() < deadline) {
      const instance = await readBackendInstance(environment);
      if (instance && await backendAuthenticated(instance)) {
        stdout.write(`Nox AI is running at http://127.0.0.1:${instance.port}\n`);
        openBrowser(`http://127.0.0.1:${instance.port}`, environment);
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`Nox AI backend exited during startup (code ${child.exitCode})${spawnError ? `: ${spawnError.message}` : ''}. Check the data directory and port ${environment.NOX_PORT ?? '4317'}.`);
      }
      if (spawnError) {
        throw new Error(`Could not start Nox AI backend: ${spawnError.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Nox AI did not become healthy within 12 seconds. Check whether port ${environment.NOX_PORT ?? '4317'} is in use.`);
  } catch (error) {
    await terminateSpawnedBackend(child);
    throw error;
  }
}

async function stopBackend(environment: Record<string, string | undefined>): Promise<void> {
  const instance = await readBackendInstance(environment);
  if (!instance || !(await backendHealth(instance))) {
    stdout.write('Nox AI backend is not running.\n');
    return;
  }
  const response = await fetch(`http://127.0.0.1:${instance.port}/api/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${instance.token}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`Backend refused shutdown (HTTP ${response.status}).`);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await backendHealth(instance)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await backendHealth(instance)) {
    throw new Error('Backend did not shut down within 5 seconds.');
  }
  stdout.write('Nox AI backend stopped.\n');
}

async function showBackendStatus(environment: Record<string, string | undefined>): Promise<void> {
  const instance = await readBackendInstance(environment);
  if (!instance || !(await backendHealth(instance))) {
    stdout.write('Backend: not running\n');
    return;
  }
  const response = await fetch(`http://127.0.0.1:${instance.port}/api/status`, {
    headers: { Authorization: `Bearer ${instance.token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`Backend status request failed (HTTP ${response.status}).`);
  }
  const result = await response.json() as {
    config: { provider: string; model: string };
    provider: { connected: boolean; error?: { message: string } };
  };
  stdout.write(`Backend: running at http://127.0.0.1:${instance.port}\n`);
  stdout.write(`Provider: ${result.config.provider} (${result.provider.connected ? 'connected' : 'disconnected'})\n`);
  stdout.write(`Model: ${result.config.model}\n`);
  if (result.provider.error) {
    stdout.write(`Provider detail: ${result.provider.error.message}\n`);
  }
}

async function uninstallManagedApplication(environment: Record<string, string | undefined>): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The managed Windows application uninstaller is available only in the Windows release package.');
  }
  const installDirectory = environment.NOX_INSTALL_DIR;
  if (!installDirectory) {
    throw new Error('This is not a managed Nox AI installation. Remove a source checkout manually; no application files were changed.');
  }
  const resolvedInstallDirectory = await realpath(installDirectory);
  const expectedInstallDirectory = await realpath(resolve(__dirname, '..', '..'));
  if (resolvedInstallDirectory.toLowerCase() !== expectedInstallDirectory.toLowerCase()) {
    throw new Error('The launcher installation path could not be verified; refusing to uninstall.');
  }
  const markerPath = join(resolvedInstallDirectory, 'nox-install.json');
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`The managed installation marker could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof marker !== 'object' || marker === null || !('productId' in marker) || marker.productId !== 'nox-ai') {
    throw new Error('The managed installation marker is invalid; refusing to uninstall.');
  }

  const uninstaller = join(resolvedInstallDirectory, 'uninstall.ps1');
  if (!existsSync(uninstaller)) {
    throw new Error('The safe uninstaller is missing. No installation or user data was changed.');
  }
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-File',
    uninstaller,
    '-WaitForProcessId',
    String(process.pid),
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  stdout.write('Uninstall scheduled. Application files will be removed after this command exits; conversation and settings data will be preserved.\n');
}

export function parseCliArguments(args: string[]): CliArguments {
  const allowRemote = args.includes('--allow-remote');
  const values = args.filter((argument) => argument !== '--allow-remote');
  return {
    command: values[0] ?? 'start',
    message: values.slice(1).join(' '),
    allowRemote,
  };
}

export function getCliModelConfig(
  environment: Record<string, string | undefined>,
  storedSettings?: StoredModelSettings
): ModelConfig {
  const overrides: Partial<ModelConfig> = storedSettings
    ? { provider: storedSettings.provider, baseUrl: storedSettings.baseUrl, model: storedSettings.model }
    : {};
  if (environment.NOX_PROVIDER) {
    overrides.provider = environment.NOX_PROVIDER as ModelConfig['provider'];
  }
  if (environment.NOX_BASE_URL) {
    overrides.baseUrl = environment.NOX_BASE_URL;
  }
  if (environment.NOX_MODEL) {
    overrides.model = environment.NOX_MODEL;
  }
  if (environment.NOX_API_KEY) {
    overrides.apiKey = environment.NOX_API_KEY;
  }
  return validateModelConfig({ ...DEFAULT_MODEL_CONFIG, ...overrides });
}

export async function loadCliModelConfig(
  environment: Record<string, string | undefined> = process.env
): Promise<ModelConfig> {
  try {
    const stored = parseStoredModelSettings(
      JSON.parse(await readFile(join(environment.NOX_DATA_DIR ?? resolveNoxDataDirectory(), 'settings.json'), 'utf8')) as unknown
    );
    return getCliModelConfig(environment, stored);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getCliModelConfig(environment);
    }
    throw new Error(`Could not load Nox settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showHelp(): void {
  stdout.write([
    'Nox AI',
    '',
    'Usage:',
    '  nox                                  Start the local web app and open its UI',
    '  nox chat [--allow-remote]            Start an interactive terminal chat',
    '  nox ask [--allow-remote] <message>   Send one prompt',
    '  nox status                           Show actual backend/provider health',
    '  nox start                            Start the local web application',
    '  nox stop                             Stop the local backend',
    '  nox doctor [--allow-remote]          Check provider connectivity',
    '  nox models [--allow-remote]          List models available from the provider',
    '  nox uninstall                        Remove managed app files; preserve user data',
    '  nox --help                           Show this help',
    '',
    'Configuration: NOX_PROVIDER, NOX_BASE_URL, NOX_MODEL, NOX_API_KEY',
    'Remote prompt and provider requests require --allow-remote for non-loopback endpoints.',
    'Use npm run build before starting the local browser app from a source checkout.',
    '',
  ].join('\n'));
}

async function checkProvider(config: ModelConfig, allowRemote: boolean): Promise<void> {
  if (requiresRemoteOptIn(config) && !allowRemote) {
    throw new Error('Remote provider check blocked. Pass --allow-remote to explicitly permit the network request.');
  }

  const models = await listProviderModels(config);
  stdout.write(`Provider reachable: ${config.provider} at ${describeEndpoint(config.baseUrl)}\n`);
  stdout.write(`Models available: ${models.length}\n`);
}

async function showModels(config: ModelConfig, allowRemote: boolean): Promise<void> {
  if (requiresRemoteOptIn(config) && !allowRemote) {
    throw new Error('Remote provider check blocked. Pass --allow-remote to explicitly permit the network request.');
  }

  const models = await listProviderModels(config);
  if (models.length === 0) {
    stdout.write('Provider is reachable but did not report any models.\n');
    return;
  }
  stdout.write(`${models.join('\n')}\n`);
}

async function runInteractiveChat(config: ModelConfig, allowRemote: boolean): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  const history: ChatMessage[] = [];
  stdout.write(`Nox AI chat using ${config.provider} (${config.model}). Type /exit to quit.\n`);

  try {
    while (true) {
      const message = (await terminal.question('you> ')).trim();
      if (message === '/exit' || message === '/quit') {
        return;
      }
      if (!message) {
        continue;
      }

      try {
        const reply = await sendChatMessage(config, history, message, { allowRemote });
        history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
        stdout.write(`nox> ${reply}\n`);
      } catch (error) {
        stdout.write(`Request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}

export async function runCli(args: string[], environment: Record<string, string | undefined> = process.env): Promise<void> {
  const parsed = parseCliArguments(args);
  if (parsed.command === '--help' || parsed.command === 'help') {
    showHelp();
    return;
  }

  if (parsed.command === 'start') {
    await startBackend(environment);
    return;
  }
  if (parsed.command === 'stop') {
    await stopBackend(environment);
    return;
  }
  if (parsed.command === 'status') {
    await showBackendStatus(environment);
    return;
  }
  if (parsed.command === 'uninstall') {
    await uninstallManagedApplication(environment);
    return;
  }

  const config = await loadCliModelConfig(environment);
  if (parsed.command === 'doctor') {
    await checkProvider(config, parsed.allowRemote);
    return;
  }
  if (parsed.command === 'models') {
    await showModels(config, parsed.allowRemote);
    return;
  }
  if (parsed.command === 'ask') {
    let message = parsed.message;
    if (!message) {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        message = await terminal.question('you> ');
      } finally {
        terminal.close();
      }
    }
    stdout.write(`${await sendChatMessage(config, [], message, { allowRemote: parsed.allowRemote })}\n`);
    return;
  }
  if (parsed.command === 'chat') {
    await runInteractiveChat(config, parsed.allowRemote);
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}. Run nox --help for usage.`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Nox AI: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}