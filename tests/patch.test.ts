import { describe, expect, it } from 'vitest';
import { parsePatch, validatePatch } from '../src/patch.js';

describe('patch validation', () => {
  it('accepts a valid unified diff for files inside the workspace', () => {
    const patch = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-export const answer = 42;
+export const answer = 43;\n`;

    expect(parsePatch(patch).files).toEqual(['src/index.ts']);
  });

  it('rejects patch traversal attempts', () => {
    const patch = `diff --git a/../evil.txt b/../evil.txt`;
    expect(() => validatePatch(patch, 'C:/workspace')).toThrow(/Unsafe patch path/);
  });
});
