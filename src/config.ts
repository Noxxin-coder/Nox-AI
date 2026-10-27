export type ProviderType = 'ollama' | 'lmstudio' | 'llamacpp' | 'omniroute' | 'openai' | 'custom';

export interface ModelConfig {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  customHeaders?: Record<string, string>;
}

export interface StoredModelSettings {
  version: 1;
  provider: ProviderType;
  baseUrl: string;
  model: string;
  remoteAllowed: boolean;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'llama3.1',
  timeoutMs: 60000,
};

export function validateModelConfig(input: Partial<ModelConfig>): ModelConfig {
  const candidate: ModelConfig = {
    ...DEFAULT_MODEL_CONFIG,
    ...input,
  };

  if (!candidate.model || !candidate.model.trim()) {
    throw new Error('A model name is required.');
  }

  if (!candidate.baseUrl || !candidate.baseUrl.trim()) {
    throw new Error('A provider base URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate.baseUrl);
  } catch {
    throw new Error('Invalid provider base URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Provider base URL must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Provider credentials must not be embedded in the base URL; configure NOX_API_KEY instead.');
  }

  const allowed = ['ollama', 'lmstudio', 'llamacpp', 'omniroute', 'openai', 'custom'];
  if (!allowed.includes(candidate.provider)) {
    throw new Error(`Unsupported provider: ${candidate.provider}`);
  }

  return candidate;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export function parseStoredModelSettings(value: unknown): StoredModelSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('provider' in value) || typeof value.provider !== 'string'
    || !('baseUrl' in value) || typeof value.baseUrl !== 'string'
    || !('model' in value) || typeof value.model !== 'string'
    || !('remoteAllowed' in value) || typeof value.remoteAllowed !== 'boolean') {
    throw new Error('Unsupported or invalid settings format.');
  }
  const config = validateModelConfig({
    provider: value.provider as ProviderType,
    baseUrl: value.baseUrl,
    model: value.model,
  });
  return {
    version: 1,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    remoteAllowed: value.remoteAllowed,
  };
}
