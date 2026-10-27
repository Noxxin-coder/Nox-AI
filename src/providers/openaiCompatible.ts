import { normalizeBaseUrl, type ModelConfig, validateModelConfig } from '../config.js';

export class ProviderRequestError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export function isModelIdentifierAvailable(model: string, availableModels: string[]): boolean {
  const normalize = (identifier: string): string => identifier.replace(/:latest$/i, '');
  const requested = normalize(model);
  return availableModels.some((available) => normalize(available) === requested);
}

function providerHeaders(config: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(config.customHeaders ?? {}) };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export async function listProviderModels(config: Partial<ModelConfig>): Promise<string[]> {
  const validated = validateModelConfig(config);
  const url = new URL('/v1/models', normalizeBaseUrl(validated.baseUrl));
  const headers: Record<string, string> = { ...(validated.customHeaders ?? {}) };

  if (validated.apiKey) {
    headers.Authorization = 'Bearer ' + validated.apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out.')), validated.timeoutMs);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    if (response.status === 404 && validated.provider === 'ollama') {
      const ollamaResponse = await fetch(
        new URL('/api/tags', normalizeBaseUrl(validated.baseUrl)).toString(),
        { headers, signal: controller.signal }
      );
      if (!ollamaResponse.ok) {
        throw new ProviderRequestError(`Model listing failed (${ollamaResponse.status}).`, ollamaResponse.status);
      }
      const ollamaData = (await ollamaResponse.json()) as Record<string, unknown>;
      if (!Array.isArray(ollamaData.models)) {
        throw new ProviderRequestError('Ollama response did not include a model list.');
      }
      return ollamaData.models.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string') {
          return [];
        }
        return [entry.name];
      });
    }
    if (!response.ok) {
      throw new ProviderRequestError(`Model listing failed (${response.status}).`, response.status);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(data.data)) {
      throw new ProviderRequestError('Provider response did not include a model list.');
    }

    return data.data.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string') {
        return [];
      }
      return [entry.id];
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ProviderRequestError(controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : 'Provider request was cancelled.');
    }
    throw new ProviderRequestError(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function streamChatCompletion(
  config: Partial<ModelConfig>,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const validated = validateModelConfig(config);
  const url = new URL('/v1/chat/completions', normalizeBaseUrl(validated.baseUrl));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out.')), validated.timeoutMs);
  const abortRequest = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortRequest, { once: true });
  if (signal?.aborted) {
    abortRequest();
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...providerHeaders(validated) },
      body: JSON.stringify({
        model: validated.model,
        messages,
        temperature: 0.2,
        max_tokens: 512,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderRequestError(`Model request failed (${response.status}).`, response.status);
    }
    if (!response.body) {
      throw new ProviderRequestError('Model provider did not return a streaming response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') {
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data) as unknown;
        } catch {
          throw new ProviderRequestError('Model provider returned malformed streaming data.');
        }
        if (typeof chunk !== 'object' || chunk === null || !('choices' in chunk) || !Array.isArray(chunk.choices)) {
          continue;
        }
        const choice = chunk.choices[0];
        if (typeof choice !== 'object' || choice === null || !('delta' in choice)
          || typeof choice.delta !== 'object' || choice.delta === null || !('content' in choice.delta)) {
          continue;
        }
        const token = choice.delta.content;
        if (typeof token === 'string') {
          answer += token;
          onToken(token);
        }
      }
      if (done) {
        break;
      }
    }
    if (buffer.trim()) {
      throw new ProviderRequestError('Model provider ended with an incomplete streaming event.');
    }
    return answer;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ProviderRequestError(controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : 'Provider request was cancelled.');
    }
    throw new ProviderRequestError(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }
}

export async function requestChatCompletion(
  config: Partial<ModelConfig>,
  messages: ChatMessage[],
  options: CompletionOptions = {}
): Promise<string> {
  const validated = validateModelConfig(config);
  const url = new URL('/v1/chat/completions', normalizeBaseUrl(validated.baseUrl));
  const payload = {
    model: validated.model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 512,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(validated.customHeaders ?? {}),
  };

  if (validated.apiKey) {
    headers.Authorization = `Bearer ${validated.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out.')), validated.timeoutMs);
  const abortRequest = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortRequest, { once: true });
  if (options.signal?.aborted) {
    abortRequest();
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderRequestError(`Model request failed (${response.status}).`, response.status);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
    const content = firstMessage?.content;

    if (typeof content !== 'string') {
      throw new ProviderRequestError('Model response did not include text output.');
    }

    return content;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ProviderRequestError(controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : 'Provider request was cancelled.');
    }
    throw new ProviderRequestError(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortRequest);
  }
}
