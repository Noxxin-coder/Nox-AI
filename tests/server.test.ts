import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoxServer } from '../src/server.js';

let providerServer: Server;
let providerPort: number;
const backendServers: NoxServer[] = [];
const temporaryDirectories: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Mock provider did not bind a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function newDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-backend-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function startBackend(options: { dataDirectory?: string; port?: number; model?: string } = {}): Promise<NoxServer> {
  const server = new NoxServer({
    dataDirectory: options.dataDirectory ?? await newDataDirectory(),
    port: options.port ?? 0,
    modelConfig: {
      provider: 'ollama',
      baseUrl: `http://127.0.0.1:${providerPort}`,
      model: options.model ?? 'mock-model',
      timeoutMs: 2000,
    },
  });
  await server.start();
  backendServers.push(server);
  return server;
}

async function getToken(server: NoxServer): Promise<string> {
  const { port } = server.address;
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = html.match(/const token = "([a-f0-9]+)"/)?.[1];
  if (!token) {
    throw new Error('Backend did not provide its local UI session token.');
  }
  return token;
}

async function close(server?: Server): Promise<void> {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

beforeAll(async () => {
  providerServer = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"mock "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  providerPort = await listen(providerServer);
});

afterAll(async () => {
  await Promise.all(backendServers.splice(0).map((server) => server.stop()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  if (providerServer?.listening) {
    await close(providerServer);
  }
});

describe('local backend integration', () => {
  it('serves accurate health and provider status on loopback', async () => {
    const server = await startBackend();
    const base = `http://127.0.0.1:${server.address.port}`;
    const health = await fetch(`${base}/api/health`);
    const token = await getToken(server);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', providerConfigured: true });
    const status = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    await expect(status.json()).resolves.toMatchObject({
      provider: { connected: true, models: ['mock-model'] },
      config: { provider: 'ollama', model: 'mock-model' },
    });
  });

  it('requires an authenticated same-origin browser API request', async () => {
    const server = await startBackend();
    const base = `http://127.0.0.1:${server.address.port}`;
    const unauthorized = await fetch(`${base}/api/status`);
    expect(unauthorized.status).toBe(401);
    const crossOrigin = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${await getToken(server)}`, Origin: 'https://attacker.example' },
    });
    expect(crossOrigin.status).toBe(403);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: server.address.port,
        path: '/api/health',
        headers: { Host: `example.test:${server.address.port}` },
      }, (response: IncomingMessage) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    expect(invalidHost).toBe(403);
  });

  it('serves a tokenized UI with a restrictive same-origin security policy', async () => {
    const server = await startBackend();
    const response = await fetch(`http://127.0.0.1:${server.address.port}/`);
    const html = await response.text();

    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(html).toContain('Your AI, on your machine.');
    expect(html).not.toContain('__NOX_TOKEN__');
    expect(html).toContain('renderMarkdown');
    expect(html).toContain('delete-conversation');
    expect(html).toContain('download Ollama for Windows');
    expect(html).toContain('Verify connection and model');
    expect(html).toContain('Set up local model');
  });

  it('streams a mock-provider reply and persists user and assistant messages', async () => {
    const directory = await newDataDirectory();
    const server = await startBackend({ dataDirectory: directory });
    const base = `http://127.0.0.1:${server.address.port}`;
    const token = await getToken(server);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const createdResponse = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: '{}' });
    const { conversation } = await createdResponse.json() as { conversation: { id: string } };
    const chatResponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: conversation.id, message: 'Say hello' }),
    });
    const stream = await chatResponse.text();
    expect(stream).toContain('"token":"mock "');
    expect(stream).toContain('"token":"reply"');
    expect(stream).toContain('"done":true');

    const historyResponse = await fetch(`${base}/api/conversations/${conversation.id}`, { headers });
    await expect(historyResponse.json()).resolves.toMatchObject({
      conversation: {
        messages: [
          { role: 'user', content: 'Say hello' },
          { role: 'assistant', content: 'mock reply' },
        ],
      },
    });
    const log = await readFile(join(directory, 'backend.log'), 'utf8');
    expect(log).not.toContain('Say hello');
  });

  it('discovers and verifies the selected model with a real test completion request', async () => {
    const server = await startBackend();
    const base = `http://127.0.0.1:${server.address.port}`;
    const token = await getToken(server);
    const response = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: 'ollama',
      model: 'mock-model',
      models: ['mock-model'],
      response: 'mock reply',
    });
  });

  it('rejects verification when the chosen model is absent from provider discovery', async () => {
    const server = await startBackend({ model: 'not-installed' });
    const response = await fetch(`http://127.0.0.1:${server.address.port}/api/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken(server)}` },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'model_not_found' },
    });
  });

  it('requires explicit opt-in before verifying an Ollama cloud model through localhost', async () => {
    const server = new NoxServer({
      dataDirectory: await newDataDirectory(),
      port: 0,
      modelConfig: {
        provider: 'ollama',
        baseUrl: `http://127.0.0.1:${providerPort}`,
        model: 'gemma4:cloud',
      },
    });
    await server.start();
    backendServers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.address.port}/api/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken(server)}` },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'remote_opt_in_required' },
    });
  });

  it('reports disconnected providers and rejects invalid chat input', async () => {
    const directory = await newDataDirectory();
    const server = await startBackend({ dataDirectory: directory, model: 'missing-model' });
    const base = `http://127.0.0.1:${server.address.port}`;
    const token = await getToken(server);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const settings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:1',
        model: 'missing-model',
        remoteAllowed: false,
      }),
    });
    expect(settings.status).toBe(200);
    const savedSettings = await readFile(join(directory, 'settings.json'), 'utf8');
    expect(savedSettings).not.toContain('apiKey');
    expect(savedSettings).not.toContain('secret');
    const status = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    await expect(status.json()).resolves.toMatchObject({ provider: { connected: false } });
    const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: '{}' });
    const { conversation } = await created.json() as { conversation: { id: string } };
    const disconnectedChat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: conversation.id, message: 'Hello' }),
    });
    expect(await disconnectedChat.text()).toContain('"code":"provider_unavailable"');
    const invalid = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: '' }) });
    expect(invalid.status).toBe(400);
    const malformed = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: '{"message":' });
    expect(malformed.status).toBe(400);
  });

  it('prevents a second backend from binding the same port and shuts down cleanly', async () => {
    const first = await startBackend();
    const duplicate = new NoxServer({
      dataDirectory: await newDataDirectory(),
      port: first.address.port,
      modelConfig: { provider: 'ollama', baseUrl: `http://127.0.0.1:${providerPort}`, model: 'mock-model' },
    });
    await expect(duplicate.start()).rejects.toThrow();
    const token = await getToken(first);
    const response = await fetch(`http://127.0.0.1:${first.address.port}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(202);
    await first.stop();
  });

  it('reloads a saved conversation after a backend restart', async () => {
    const directory = await newDataDirectory();
    const first = await startBackend({ dataDirectory: directory });
    const base = `http://127.0.0.1:${first.address.port}`;
    const token = await getToken(first);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: '{}' });
    const { conversation } = await created.json() as { conversation: { id: string } };
    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: conversation.id, message: 'Persist across restart' }),
    });
    await first.stop();

    const restarted = await startBackend({ dataDirectory: directory });
    const loaded = await fetch(`http://127.0.0.1:${restarted.address.port}/api/conversations/${conversation.id}`, {
      headers: { Authorization: `Bearer ${await getToken(restarted)}` },
    });
    await expect(loaded.json()).resolves.toMatchObject({
      conversation: {
        messages: [
          { role: 'user', content: 'Persist across restart' },
          { role: 'assistant', content: 'mock reply' },
        ],
      },
    });
  });
});
