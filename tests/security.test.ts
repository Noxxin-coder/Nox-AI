import { describe, expect, it } from 'vitest';
import { isDangerousShellCommand, redactSecrets, validateWorkspacePath } from '../src/security.js';

describe('security helpers', () => {
  it('redacts API keys and bearer tokens', () => {
    const value = 'Authorization: Bearer abc123xyz and apiKey="secret12345"';
    const redacted = redactSecrets(value);
    expect(redacted).toContain('[REDACTED_TOKEN]');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('abc123xyz');
    expect(redacted).not.toContain('secret12345');
  });

  it('prevents escaping the workspace root', () => {
    expect(() => validateWorkspacePath('C:/workspace', '../outside.txt')).toThrow(/Path escapes workspace root/);
  });

  it('flags dangerous shell commands', () => {
    expect(isDangerousShellCommand('rm -rf /tmp/test')).toBe(true);
    expect(isDangerousShellCommand('npm test')).toBe(false);
  });
});
