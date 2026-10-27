import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeEndpoint, isLocalEndpoint, requiresRemoteOptIn, sendChatMessage } from '../src/runtime.js';

describe('shared chat runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies loopback endpoints', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalEndpoint('http://[::1]:8080/v1')).toBe(true);
    expect(isLocalEndpoint('https://api.example.com/v1')).toBe(false);
  });

  it('requires explicit opt-in for Ollama cloud model names on a loopback server', () => {
    expect(requiresRemoteOptIn({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'gemma4:cloud',
    })).toBe(true);
    expect(requiresRemoteOptIn({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2',
    })).toBe(false);
  });

  it('describes endpoints without credentials, paths, or query strings', () => {
    expect(describeEndpoint('https://user:secret@example.com/v1?token=hidden'))
      .toBe('https://example.com');
  });

  it('blocks remote requests unless explicitly allowed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendChatMessage({
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'remote-model',
    }, [], 'hello')).rejects.toThrow(/Remote model endpoint blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks Ollama cloud models on a loopback endpoint unless explicitly allowed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      provider: 'ollama' as const,
      baseUrl: 'http://localhost:11434',
      model: 'gemma4:cloud',
    };

    await expect(sendChatMessage(config, [], 'hello')).rejects.toThrow(/Remote model endpoint blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(sendChatMessage(config, [], 'hello', { allowRemote: true })).rejects.toThrow(/Provider request failed/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the configured local provider and includes prior messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello back' } }] }),
    }));

    const result = await sendChatMessage({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'assistant', content: 'Previous reply' }], 'hello');

    expect(result).toBe('hello back');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'llama3.1',
          messages: [
            { role: 'assistant', content: 'Previous reply' },
            { role: 'user', content: 'hello' },
          ],
          temperature: 0.2,
          max_tokens: 512,
        }),
      })
    );
  });

  it('allows remote requests only when explicitly opted in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'remote reply' } }] }),
    }));

    await expect(sendChatMessage({
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'remote-model',
    }, [], 'hello', { allowRemote: true })).resolves.toBe('remote reply');
  });

  it('rejects empty messages', async () => {
    await expect(sendChatMessage({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [], '  ')).rejects.toThrow(/non-empty message/);
  });
});