import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCliModelConfig, loadCliModelConfig, parseCliArguments, runCli } from '../src/cli.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CLI configuration and arguments', () => {
  it('defaults to launching the local web application', () => {
    expect(parseCliArguments([])).toEqual({ command: 'start', message: '', allowRemote: false });
  });

  it('parses a one-shot prompt and explicit remote permission', () => {
    expect(parseCliArguments(['ask', 'summarize', 'this', '--allow-remote'])).toEqual({
      command: 'ask',
      message: 'summarize this',
      allowRemote: true,
    });
  });

  it('uses the local default and environment overrides', () => {
    expect(getCliModelConfig({})).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });
    expect(getCliModelConfig({
      NOX_PROVIDER: 'custom',
      NOX_BASE_URL: 'https://models.example.com/v1',
      NOX_MODEL: 'private-model',
      NOX_API_KEY: 'secret',
    })).toMatchObject({
      provider: 'custom',
      baseUrl: 'https://models.example.com/v1',
      model: 'private-model',
      apiKey: 'secret',
    });
  });

  it('uses settings saved by the web UI and lets environment credentials override them', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nox-cli-settings-'));
    try {
      await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
        version: 1,
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        remoteAllowed: false,
      }));

      await expect(loadCliModelConfig({
        NOX_DATA_DIR: dataDirectory,
        NOX_API_KEY: 'session-key',
      })).resolves.toMatchObject({
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        apiKey: 'session-key',
      });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('uses saved provider settings for model discovery', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nox-cli-models-'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'installed-model' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
        version: 1,
        provider: 'lmstudio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'installed-model',
        remoteAllowed: false,
      }));

      await runCli(['models'], { NOX_DATA_DIR: dataDirectory });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/v1/models',
        expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) })
      );
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('requires explicit CLI opt-in for saved Ollama cloud model names', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nox-cli-cloud-'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
        version: 1,
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'gemma4:cloud',
        remoteAllowed: true,
      }));

      await expect(runCli(['models'], { NOX_DATA_DIR: dataDirectory })).rejects.toThrow(/Remote provider check blocked/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('blocks remote model discovery without explicit permission', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCli(['models'], {
      NOX_PROVIDER: 'custom',
      NOX_BASE_URL: 'https://models.example.com/v1',
      NOX_MODEL: 'private-model',
    })).rejects.toThrow(/Remote provider check blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not pretend to start from an unbuilt source tree', async () => {
    await expect(runCli(['start'], {})).rejects.toThrow(/backend has not been built/);
  });

  it('reports an idle backend on stop without claiming it was running', async () => {
    await expect(runCli(['stop'], { NOX_DATA_DIR: 'nox-test-data-not-created' })).resolves.toBeUndefined();
  });

  it('refuses to uninstall files outside a verified managed installation', async () => {
    await expect(runCli(['uninstall'], {})).rejects.toThrow(/managed Windows application|not a managed Nox AI installation/);
  });
});