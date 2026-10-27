import { validateModelConfig, type ModelConfig } from './config.js';
import { requestChatCompletion, type ChatMessage } from './providers/openaiCompatible.js';

export interface RuntimeChatOptions {
  allowRemote?: boolean;
}

export function isLocalEndpoint(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function requiresRemoteOptIn(config: Pick<ModelConfig, 'baseUrl' | 'provider' | 'model'>): boolean {
  return !isLocalEndpoint(config.baseUrl)
    || (config.provider === 'ollama' && config.model.toLowerCase().endsWith(':cloud'));
}

export function describeEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  return `${endpoint.protocol}//${endpoint.host}`;
}

export async function sendChatMessage(
  config: Partial<ModelConfig>,
  history: ChatMessage[],
  message: string,
  options: RuntimeChatOptions = {}
): Promise<string> {
  const validated = validateModelConfig(config);
  if (requiresRemoteOptIn(validated) && !options.allowRemote) {
    throw new Error('Remote model endpoint blocked. Pass --allow-remote to explicitly permit sending this prompt.');
  }

  if (!message.trim()) {
    throw new Error('A non-empty message is required.');
  }

  return requestChatCompletion(validated, [...history, { role: 'user', content: message }]);
}