import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/conversations.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-conversations-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local conversation store', () => {
  it('creates, lists, appends, loads, and deletes persisted conversations', async () => {
    const directory = await createTemporaryDirectory();
    const store = new ConversationStore(directory);
    const created = await store.create();
    await store.appendMessage(created.id, 'user', 'Help me understand this.');
    await store.appendMessage(created.id, 'assistant', 'Here is an explanation.');

    const listing = await store.list();
    expect(listing).toHaveLength(1);
    expect(listing[0].title).toBe('Help me understand this.');
    expect(listing[0].messages).toEqual([]);
    await expect(new ConversationStore(directory).get(created.id)).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'Help me understand this.' },
        { role: 'assistant', content: 'Here is an explanation.' },
      ],
    });

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.delete(created.id)).toBe(false);
    await expect(readFile(join(directory, 'conversations.json'), 'utf8')).resolves.toContain('"conversations":[]');
  });

  it('reports malformed or unsupported storage instead of silently discarding data', async () => {
    const directory = await createTemporaryDirectory();
    const store = new ConversationStore(directory);
    await store.initialize();
    await store.create();
    const path = join(directory, 'conversations.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ version: 99, conversations: [] }));

    await expect(new ConversationStore(directory).list()).rejects.toThrow(/invalid conversation data format/);
  });
});
