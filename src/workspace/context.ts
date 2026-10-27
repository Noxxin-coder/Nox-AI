import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { DEFAULT_EXCLUDED_PATTERNS, isExcluded } from '../security.js';

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
}

export interface WorkspaceScanOptions {
  exclude?: string[];
  maxFiles?: number;
  maxFileSize?: number;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2', '.mp3', '.mp4', '.exe', '.dll', '.so', '.dylib', '.bin'
]);

export async function scanWorkspace(root: string, options: WorkspaceScanOptions = {}): Promise<WorkspaceFile[]> {
  const exclude = [...DEFAULT_EXCLUDED_PATTERNS, ...(options.exclude ?? [])];
  const maxFiles = options.maxFiles ?? 250;
  const maxFileSize = options.maxFileSize ?? 200 * 1024;
  const results: WorkspaceFile[] = [];
  const seen = new Set<string>();

  async function walk(currentPath: string): Promise<void> {
    if (results.length >= maxFiles) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }

      const absolute = join(currentPath, entry.name);
      const relativePath = relative(root, absolute).replace(/\\/g, '/');

      if (isExcluded(relativePath, exclude) || entry.name === '.git') {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) {
        continue;
      }

      const fileStats = await stat(absolute);
      if (fileStats.size > maxFileSize) {
        continue;
      }

      if (seen.has(absolute)) {
        continue;
      }
      seen.add(absolute);

      const content = await readFile(absolute, 'utf8');
      results.push({
        path: absolute,
        content,
        size: content.length,
      });
    }
  }

  await walk(resolve(root));
  return results;
}
