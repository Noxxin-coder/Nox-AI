import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_MODEL_CONFIG,
  parseStoredModelSettings,
  validateModelConfig,
  type ModelConfig,
  type ProviderType,
  type StoredModelSettings,
} from './config.js';
import { ConversationStore } from './conversations.js';
import { describeEndpoint, isLocalEndpoint, requiresRemoteOptIn } from './runtime.js';
import {
  listProviderModels,
  isModelIdentifierAvailable,
  ProviderRequestError,
  streamChatCompletion,
  type ChatMessage,
} from './providers/openaiCompatible.js';

export interface NoxServerOptions {
  dataDirectory?: string;
  port?: number;
  host?: string;
  modelConfig?: Partial<ModelConfig>;
  remoteAllowed?: boolean;
}

interface InstanceInfo {
  pid: number;
  port: number;
  token: string;
}

export function resolveNoxDataDirectory(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  return base ? join(base, 'Nox AI') : join(homedir(), '.nox-ai');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function writeDiagnosticLog(dataDirectory: string, message: string): Promise<void> {
  await appendFile(join(dataDirectory, 'backend.log'), `${JSON.stringify({ time: new Date().toISOString(), message })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function readJson(request: IncomingMessage, maximumBytes = 64 * 1024): Promise<unknown> {
  let contents = '';
  for await (const chunk of request) {
    contents += chunk.toString();
    if (Buffer.byteLength(contents) > maximumBytes) {
      throw new Error('Request body is too large.');
    }
  }
  try {
    return JSON.parse(contents || '{}') as unknown;
  } catch {
    throw new SyntaxError('Request body must be valid JSON.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NoxServer {
  private readonly server: Server;
  private readonly store: ConversationStore;
  private readonly dataDirectory: string;
  private readonly instanceFile: string;
  private readonly token: string;
  private readonly activeChatRequests = new Set<AbortController>();
  private readonly port: number;
  private readonly host: string;
  private readonly modelConfigOverrides: Partial<ModelConfig>;
  private config: ModelConfig;
  private remoteAllowed: boolean;
  private listening = false;

  constructor(options: NoxServerOptions = {}) {
    this.dataDirectory = options.dataDirectory ?? process.env.NOX_DATA_DIR ?? resolveNoxDataDirectory();
    this.instanceFile = join(this.dataDirectory, 'backend-instance.json');
    this.store = new ConversationStore(this.dataDirectory);
    this.port = options.port ?? Number(process.env.NOX_PORT ?? 4317);
    this.host = options.host ?? '127.0.0.1';
    this.modelConfigOverrides = options.modelConfig ?? this.readEnvironmentConfig();
    this.config = validateModelConfig({ ...DEFAULT_MODEL_CONFIG, ...this.modelConfigOverrides });
    this.remoteAllowed = options.remoteAllowed ?? false;
    this.token = randomBytes(32).toString('hex');
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        void writeDiagnosticLog(
          this.dataDirectory,
          `Request failed: ${error instanceof Error ? error.message : 'Unexpected backend error.'}`
        ).catch((logError: unknown) => {
          console.error(`Nox AI could not write backend diagnostics: ${logError instanceof Error ? logError.message : String(logError)}`);
        });
        if (!response.headersSent) {
          if (error instanceof SyntaxError) {
            sendError(response, 400, 'invalid_json', 'Request body must be valid JSON.');
          } else if (error instanceof Error && error.message === 'Request body is too large.') {
            sendError(response, 413, 'request_too_large', error.message);
          } else if (error instanceof ProviderRequestError) {
            const timedOut = error.message.toLowerCase().includes('timed out');
            sendError(response, timedOut ? 504 : 502, timedOut ? 'provider_timeout' : 'provider_unavailable', error.message);
          } else {
            sendError(response, 500, 'internal_error', error instanceof Error ? error.message : 'Unexpected backend error.');
          }
        } else {
          response.end();
        }
      });
    });
  }

  get address(): { host: string; port: number } {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Backend is not listening on a TCP port.');
    }
    return { host: this.host, port: address.port };
  }

  async start(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await this.store.initialize();
    await this.readStoredSettings();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    this.listening = true;
    const instance: InstanceInfo = { pid: process.pid, port: this.address.port, token: this.token };
    const temporaryInstancePath = `${this.instanceFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryInstancePath, JSON.stringify(instance), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryInstancePath, this.instanceFile);
      await writeDiagnosticLog(this.dataDirectory, `Backend started at 127.0.0.1:${instance.port}.`);
    } catch (error) {
      await unlink(temporaryInstancePath).catch(() => undefined);
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.listening = false;
      await unlink(this.instanceFile).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Nox AI could not remove backend instance metadata: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    for (const controller of this.activeChatRequests) {
      controller.abort(new Error('Backend is shutting down.'));
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    this.listening = false;
    let cleanupError: unknown;
    try {
      const saved = JSON.parse(await readFile(this.instanceFile, 'utf8')) as Partial<InstanceInfo>;
      if (saved.pid === process.pid) {
        await unlink(this.instanceFile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupError = error;
      }
    }
    await writeDiagnosticLog(this.dataDirectory, 'Backend stopped.');
    if (cleanupError) {
      throw cleanupError;
    }
  }

  private readEnvironmentConfig(): Partial<ModelConfig> {
    const config: Partial<ModelConfig> = {};
    if (process.env.NOX_PROVIDER) {
      config.provider = process.env.NOX_PROVIDER as ProviderType;
    }
    if (process.env.NOX_BASE_URL) {
      config.baseUrl = process.env.NOX_BASE_URL;
    }
    if (process.env.NOX_MODEL) {
      config.model = process.env.NOX_MODEL;
    }
    if (process.env.NOX_API_KEY) {
      config.apiKey = process.env.NOX_API_KEY;
    }
    return config;
  }

  private async readStoredSettings(): Promise<void> {
    try {
      const settings = parseStoredModelSettings(
        JSON.parse(await readFile(join(this.dataDirectory, 'settings.json'), 'utf8')) as unknown
      );
      this.config = validateModelConfig({
        ...settings,
        ...this.modelConfigOverrides,
        ...(process.env.NOX_API_KEY ? { apiKey: process.env.NOX_API_KEY } : {}),
      });
      this.remoteAllowed = settings.remoteAllowed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not load Nox settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async saveSettings(): Promise<void> {
    const settings: StoredModelSettings = {
      version: 1,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      remoteAllowed: this.remoteAllowed,
    };
    const path = join(this.dataDirectory, 'settings.json');
    const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private validateBrowserRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
      sendError(response, 400, 'invalid_host', 'A local Host header is required.');
      return false;
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      sendError(response, 400, 'invalid_host', 'Invalid Host header.');
      return false;
    }
    if (!['127.0.0.1', 'localhost'].includes(hostname)) {
      sendError(response, 403, 'host_forbidden', 'Nox AI accepts requests only through a loopback host.');
      return false;
    }

    const origin = request.headers.origin;
    if (origin && origin !== `http://${hostHeader}`) {
      sendError(response, 403, 'origin_forbidden', 'Cross-origin requests are not allowed.');
      return false;
    }
    if (request.method === 'OPTIONS') {
      sendError(response, 405, 'method_not_allowed', 'Cross-origin preflight requests are not supported.');
      return false;
    }
    return true;
  }

  private authorized(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      sendError(response, 401, 'unauthorized', 'A valid local session token is required.');
      return false;
    }
    return true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.validateBrowserRequest(request, response)) {
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, { service: 'nox-ai', status: 'ok', providerConfigured: Boolean(this.config.baseUrl && this.config.model) });
      return;
    }
    if (url.pathname.startsWith('/api/') && !this.authorized(request, response)) {
      return;
    }

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const result = await this.providerStatus();
      sendJson(response, 200, result);
      return;
    }
    if (url.pathname === '/api/models' && request.method === 'GET') {
      if (!isLocalEndpoint(this.config.baseUrl) && !this.remoteAllowed) {
        sendError(response, 403, 'remote_opt_in_required', 'Enable remote-provider opt-in in settings before making a request.');
        return;
      }
      const models = await listProviderModels(this.config);
      sendJson(response, 200, { models });
      return;
    }
    if (url.pathname === '/api/verify' && request.method === 'POST') {
      if (requiresRemoteOptIn(this.config) && !this.remoteAllowed) {
        sendError(response, 403, 'remote_opt_in_required', 'Enable remote-provider opt-in in settings before sending a test prompt.');
        return;
      }
      const models = await listProviderModels(this.config);
      if (!isModelIdentifierAvailable(this.config.model, models)) {
        sendError(
          response,
          400,
          'model_not_found',
          `The provider did not report the selected model "${this.config.model}". Select an installed model and retry.`
        );
        return;
      }
      const responseText = await streamChatCompletion(
        this.config,
        [{ role: 'user', content: 'Reply with exactly: Nox local model connection verified.' }],
        () => undefined
      );
      if (!responseText.trim()) {
        sendError(response, 502, 'empty_model_response', 'The model accepted the test request but returned no text.');
        return;
      }
      sendJson(response, 200, { provider: this.config.provider, model: this.config.model, models, response: responseText });
      return;
    }
    if (url.pathname === '/api/settings' && request.method === 'PUT') {
      const body = await readJson(request);
      if (!isRecord(body) || typeof body.provider !== 'string' || typeof body.baseUrl !== 'string'
        || typeof body.model !== 'string' || typeof body.remoteAllowed !== 'boolean') {
        sendError(response, 400, 'invalid_settings', 'Provider, baseUrl, model, and remoteAllowed are required.');
        return;
      }
      if (body.baseUrl.length > 2048 || body.model.length > 200) {
        sendError(response, 400, 'invalid_settings', 'Endpoint or model identifier is too long.');
        return;
      }
      let updated: ModelConfig;
      try {
        updated = validateModelConfig({
          provider: body.provider as ProviderType,
          baseUrl: body.baseUrl,
          model: body.model,
          apiKey: process.env.NOX_API_KEY,
        });
      } catch (error) {
        sendError(response, 400, 'invalid_settings', error instanceof Error ? error.message : 'Invalid provider settings.');
        return;
      }
      this.config = updated;
      this.remoteAllowed = body.remoteAllowed;
      await this.saveSettings();
      sendJson(response, 200, { config: this.publicConfig() });
      return;
    }
    if (url.pathname === '/api/conversations' && request.method === 'GET') {
      sendJson(response, 200, { conversations: await this.store.list() });
      return;
    }
    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      const conversation = await this.store.create();
      sendJson(response, 201, { conversation });
      return;
    }
    const conversationRoute = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/i);
    if (conversationRoute && request.method === 'GET') {
      const conversation = await this.store.get(conversationRoute[1]);
      if (!conversation) {
        sendError(response, 404, 'conversation_not_found', 'Conversation not found.');
        return;
      }
      sendJson(response, 200, { conversation });
      return;
    }
    if (conversationRoute && request.method === 'DELETE') {
      const deleted = await this.store.delete(conversationRoute[1]);
      if (!deleted) {
        sendError(response, 404, 'conversation_not_found', 'Conversation not found.');
        return;
      }
      sendJson(response, 200, { deleted: true });
      return;
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      await this.handleChat(request, response);
      return;
    }
    if (url.pathname === '/api/shutdown' && request.method === 'POST') {
      sendJson(response, 202, { shuttingDown: true });
      setImmediate(() => void this.stop());
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendError(response, 404, 'not_found', 'API route not found.');
      return;
    }
    this.serveFrontend(url.pathname, response);
  }

  private publicConfig(): Record<string, unknown> {
    return {
      provider: this.config.provider,
      baseUrl: describeEndpoint(this.config.baseUrl),
      model: this.config.model,
      remoteAllowed: this.remoteAllowed,
      isLocal: isLocalEndpoint(this.config.baseUrl),
    };
  }

  private async providerStatus(): Promise<Record<string, unknown>> {
    const publicConfig = this.publicConfig();
    if (requiresRemoteOptIn(this.config) && !this.remoteAllowed) {
      return {
        config: publicConfig,
        provider: {
          connected: false,
          models: [],
          error: { code: 'remote_opt_in_required', message: 'This endpoint or model requires explicit remote-provider opt-in.' },
        },
      };
    }
    try {
      const models = await listProviderModels(this.config);
      return { config: publicConfig, provider: { connected: true, models } };
    } catch (error) {
      return {
        config: publicConfig,
        provider: {
          connected: false,
          models: [],
          error: {
            code: error instanceof ProviderRequestError && error.message.toLowerCase().includes('timed out')
              ? 'provider_timeout'
              : 'provider_unavailable',
            message: error instanceof Error ? error.message : 'Provider request failed.',
          },
        },
      };
    }
  }

  private async handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (requiresRemoteOptIn(this.config) && !this.remoteAllowed) {
      sendError(response, 403, 'remote_opt_in_required', 'Enable remote-provider opt-in in settings before sending prompts to this endpoint or model.');
      return;
    }
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.conversationId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(body.conversationId)
      || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 20000) {
      sendError(response, 400, 'invalid_chat_request', 'A conversationId and non-empty message of at most 20,000 characters are required.');
      return;
    }
    const conversation = await this.store.get(body.conversationId);
    if (!conversation) {
      sendError(response, 404, 'conversation_not_found', 'Conversation not found.');
      return;
    }
    const userMessage = await this.store.appendMessage(conversation.id, 'user', body.message.trim());
    const history: ChatMessage[] = userMessage.messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
    history.push({ role: 'user', content: body.message.trim() });

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const controller = new AbortController();
    this.activeChatRequests.add(controller);
    response.once('close', () => {
      if (!response.writableEnded) {
        controller.abort(new Error('Client disconnected.'));
      }
    });
    const emit = (event: unknown): void => {
      if (!response.destroyed) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    let answer = '';
    try {
      answer = await streamChatCompletion(this.config, history, (token) => emit({ token }), controller.signal);
      await this.store.appendMessage(conversation.id, 'assistant', answer);
      emit({ done: true });
      response.end();
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.destroyed) {
          response.end();
        }
      } else {
        const message = error instanceof Error ? error.message : 'The model request failed.';
        emit({
          error: {
            code: error instanceof ProviderRequestError && message.toLowerCase().includes('timed out')
              ? 'provider_timeout'
              : 'provider_unavailable',
            message,
          },
        });
        response.end();
      }
    } finally {
      this.activeChatRequests.delete(controller);
    }
  }

  private serveFrontend(pathname: string, response: ServerResponse): void {
    if (pathname !== '/' && pathname !== '/index.html') {
      sendError(response, 404, 'not_found', 'Page not found.');
      return;
    }
    const candidates = [
      join(__dirname, 'web', 'index.html'),
      resolve(__dirname, '..', '..', 'src', 'web', 'index.html'),
    ];
    let html: string | undefined;
    for (const candidate of candidates) {
      try {
        html = readFileSync(candidate, 'utf8');
        break;
      } catch {
        continue;
      }
    }
    if (html === undefined) {
      sendError(response, 500, 'frontend_missing', 'The web UI is missing. Build or restore src/web/index.html.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(html.replace('__NOX_TOKEN__', this.token));
  }
}

export async function startNoxServer(options: NoxServerOptions = {}): Promise<NoxServer> {
  const server = new NoxServer(options);
  await server.start();
  return server;
}

if (require.main === module) {
  void startNoxServer().then((server) => {
    const { host, port } = server.address;
    console.log(`Nox AI backend listening at http://${host}:${port}`);
    const shutdown = (): void => {
      void server.stop().then(() => process.exit(0)).catch((error: unknown) => {
        console.error(`Nox AI shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error: unknown) => {
    console.error(`Nox AI backend failed to start: ${error instanceof Error ? error.message : String(error)}`);
    void writeDiagnosticLog(
      process.env.NOX_DATA_DIR ?? resolveNoxDataDirectory(),
      `Backend failed to start: ${error instanceof Error ? error.message : 'Unexpected startup error.'}`
    ).catch((logError: unknown) => {
      console.error(`Nox AI could not write backend diagnostics: ${logError instanceof Error ? logError.message : String(logError)}`);
    });
    process.exitCode = 1;
  });
}
