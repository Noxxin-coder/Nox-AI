import { describe, expect, it } from 'vitest';
import { boundedRepairLoop } from '../src/repair.js';

describe('bounded repair loops', () => {
  it('stops successfully when the condition is met', async () => {
    let attempts = 0;
    const result = await boundedRepairLoop(async (attempt) => {
      attempts += 1;
      return attempt >= 2 ? 'fixed' : 'retry';
    }, {
      maxAttempts: 5,
      shouldStop: (value) => value === 'fixed',
    });

    expect(result).toBe('fixed');
    expect(attempts).toBe(2);
  });

  it('throws when the retry budget is exhausted', async () => {
    await expect(boundedRepairLoop(async () => 'retry', {
      maxAttempts: 3,
      shouldStop: () => false,
    })).rejects.toThrow(/Repair loop exhausted/);
  });
});
