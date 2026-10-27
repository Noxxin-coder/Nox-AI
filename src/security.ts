import { relative, resolve } from 'node:path';

export const DEFAULT_EXCLUDED_PATTERNS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
];

export function redactSecrets(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9]{8,})/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+[A-Za-z0-9._-]+)/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/(Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+)/gi, 'Authorization: Bearer [REDACTED_TOKEN]')
    .replace(/(api[_-]?key\s*[:=]\s*['\"]?)([A-Za-z0-9._-]{8,})/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*['\"]?)([A-Za-z0-9._-]{8,})/gi, '$1[REDACTED]');
}

export function validateWorkspacePath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);

  if (relativePath.startsWith('..') || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Path escapes workspace root: ${candidate}`);
  }

  return resolvedCandidate;
}

export function isExcluded(path: string, patterns: string[] = DEFAULT_EXCLUDED_PATTERNS): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    const trimmed = pattern.replace(/\\/g, '/');
    return normalized.includes(`/${trimmed}/`) || normalized.startsWith(`${trimmed}/`) || normalized === trimmed;
  });
}

export function isDangerousShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  return /(^|\s)(rm\s+-rf|mkfs|chmod\s+-R\s+777|sudo\s+|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh)/i.test(normalized);
}
