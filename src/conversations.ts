import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface ConversationFile {
  version: 1;
  conversations: Conversation[];
}

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Conversation>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && Array.isArray(candidate.messages)
    && candidate.messages.every((message) => typeof message === 'object'
      && message !== null
      && typeof message.id === 'string'
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && typeof message.createdAt === 'string');
}

export class ConversationStore {
  private readonly filePath: string;
  private conversations: Conversation[] = [];
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, 'conversations.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const contents = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== 'object' || parsed === null
        || !('version' in parsed) || parsed.version !== 1
        || !('conversations' in parsed) || !Array.isArray(parsed.conversations)
        || !parsed.conversations.every(isConversation)) {
        throw new Error('Unsupported or invalid conversation data format.');
      }
      this.conversations = parsed.conversations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not load conversation history: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.initialized = true;
  }

  async list(): Promise<Conversation[]> {
    await this.initialize();
    return [...this.conversations]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ messages: _messages, ...conversation }) => ({ ...conversation, messages: [] }));
  }

  async get(id: string): Promise<Conversation | undefined> {
    await this.initialize();
    const conversation = this.conversations.find((entry) => entry.id === id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  async create(): Promise<Conversation> {
    await this.initialize();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.conversations.push(conversation);
    await this.persist();
    return structuredClone(conversation);
  }

  async appendMessage(
    conversationId: string,
    role: ConversationMessage['role'],
    content: string
  ): Promise<Conversation> {
    await this.initialize();
    const conversation = this.conversations.find((entry) => entry.id === conversationId);
    if (!conversation) {
      throw new Error('Conversation not found.');
    }
    const now = new Date().toISOString();
    conversation.messages.push({ id: randomUUID(), role, content, createdAt: now });
    if (role === 'user' && conversation.title === 'New conversation') {
      conversation.title = content.trim().slice(0, 60) || 'New conversation';
    }
    conversation.updatedAt = now;
    await this.persist();
    return structuredClone(conversation);
  }

  async delete(id: string): Promise<boolean> {
    await this.initialize();
    const index = this.conversations.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return false;
    }
    this.conversations.splice(index, 1);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const snapshot: ConversationFile = {
      version: 1,
      conversations: structuredClone(this.conversations),
    };
    const write = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }
}
