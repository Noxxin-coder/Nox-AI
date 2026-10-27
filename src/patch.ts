import { validateWorkspacePath } from './security.js';

export interface PatchSummary {
  files: string[];
  raw: string;
}

export function parsePatch(raw: string): PatchSummary {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Patch content is required.');
  }

  const files = Array.from(raw.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)).map((match) => match[2]);

  if (files.length === 0 && !raw.includes('@@')) {
    throw new Error('Patch is not a valid unified diff or git patch.');
  }

  return {
    files,
    raw,
  };
}

export function validatePatch(raw: string, root: string): string[] {
  const patch = parsePatch(raw);
  const safeFiles: string[] = [];

  for (const file of patch.files) {
    const cleaned = file.replace(/^\//, '');
    if (cleaned.includes('..') || cleaned.startsWith('/')) {
      throw new Error(`Unsafe patch path detected: ${file}`);
    }

    validateWorkspacePath(root, cleaned);
    safeFiles.push(cleaned);
  }

  return safeFiles;
}
