import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG, validateModelConfig } from '../src/config.js';

describe('configuration validation', () => {
  it('accepts a valid local model configuration', () => {
    const config = validateModelConfig({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });

    expect(config).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });
  });

  it('uses default values when partial config is provided', () => {
    const config = validateModelConfig({ model: 'tinyllama' });
    expect(config.model).toBe('tinyllama');
    expect(config.baseUrl).toBe(DEFAULT_MODEL_CONFIG.baseUrl);
  });

  it('rejects invalid URLs and missing models', () => {
    expect(() => validateModelConfig({ baseUrl: 'not-a-url', model: 'demo' })).toThrow(/Invalid provider base URL/);
    expect(() => validateModelConfig({ baseUrl: 'http://localhost:11434', model: '' })).toThrow(/A model name is required/);
  });

  it('rejects credentials embedded in provider URLs', () => {
    expect(() => validateModelConfig({
      baseUrl: 'https://user:password@example.com/v1',
      model: 'demo',
    })).toThrow(/must not be embedded in the base URL/);
  });

  it('does not echo invalid endpoint input into errors', () => {
    let message = '';
    try {
      validateModelConfig({
        baseUrl: 'https://private-token.invalid:bad/',
        model: 'demo',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Invalid provider base URL/);
    expect(message).not.toContain('private-token');
  });
});
