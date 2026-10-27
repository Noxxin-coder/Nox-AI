import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace } from '../src/workspace/context.js';

describe('workspace scanning', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it('ignores excluded folders and reads text files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-workspace-'));
    tempRoots.push(root);

    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(root, 'node_modules', 'ignored', 'index.js'), 'bad');

    const files = await scanWorkspace(root, { maxFiles: 25 });
    const normalized = files.map((file) => file.path.replace(/\\/g, '/'));
    expect(normalized.some((file) => file.includes('/node_modules/'))).toBe(false);
    expect(normalized.some((file) => file.includes('/src/index.ts'))).toBe(true);
  });
});
