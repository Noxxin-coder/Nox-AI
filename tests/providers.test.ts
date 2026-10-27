import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isModelIdentifierAvailable,
  listProviderModels,
  ProviderRequestError,
  requestChatCompletion,
  streamChatCompletion,
} from '../src/providers/openaiCompatible.js';

describe('OpenAI-like provider handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an untagged Ollama model when discovery returns the latest tag', () => {
    expect(isModelIdentifierAvailable('llama3.2', ['llama3.2:latest', 'qwen3:8b'])).toBe(true);
    expect(isModelIdentifierAvailable('llama3.2:8b', ['llama3.2:latest'])).toBe(false);
  });

  it('lists model identifiers reported by the provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'model-a' }, { id: 'model-b' }, { name: 'ignored' }, null],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProviderModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    })).resolves.toEqual(['model-a', 'model-b']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.objectContaining({ headers: {} })
    );
  });

  it('uses Ollama native model discovery when its OpenAI model route is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2:latest' }, { model: 'ignored' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProviderModels({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3.2:latest',
    })).resolves.toEqual(['llama3.2:latest']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:11434/api/tags',
    ]);
  });

  it('rejects invalid model-list responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    }));

    await expect(listProviderModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    })).rejects.toThrow(/did not include a model list/);
  });

  it('parses streamed provider tokens and requests streaming output', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
    vi.stubGlobal('fetch', fetchMock);
    const tokens: string[] = [];

    await expect(streamChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }], (token) => tokens.push(token)))
      .resolves.toBe('hello world');
    expect(tokens).toEqual(['hello ', 'world']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ stream: true });
  });

  it('cancels a streaming provider request when the caller aborts', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })));
    const request = streamChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }], () => undefined, controller.signal);
    controller.abort(new Error('cancelled by user'));

    await expect(request).rejects.toThrow(/cancelled by user/);
  });

  it('aborts a streaming response when the provider timeout expires', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => Promise.resolve({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      }),
    })));

    await expect(streamChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      timeoutMs: 1,
    }, [{ role: 'user', content: 'hello' }], () => undefined)).rejects.toThrow(/timed out/);
  });

  it('rejects malformed streaming events rather than silently accepting them', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {not-json}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));

    await expect(streamChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }], () => undefined))
      .rejects.toThrow(/malformed streaming data/);
  });

  it('returns text from a successful completion response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'done' },
        }],
      }),
    }));

    const content = await requestChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }]);

    expect(content).toBe('done');
  });

  it('throws a provider error when the completion request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server exploded',
    }));

    await expect(requestChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }])).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('aborts a provider request when its timeout expires', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })));

    await expect(requestChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      timeoutMs: 1,
    }, [{ role: 'user', content: 'hello' }])).rejects.toThrow(/timed out/);
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => Promise.resolve({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    })));

    await expect(requestChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      timeoutMs: 1,
    }, [{ role: 'user', content: 'hello' }])).rejects.toThrow(/timed out/);
  });

  it('honors caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      if (init.signal?.aborted) {
        reject(init.signal.reason);
      }
    })));

    await expect(requestChatCompletion({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    }, [{ role: 'user', content: 'hello' }], { signal: controller.signal })).rejects.toThrow(/cancelled by caller/);
  });
});
