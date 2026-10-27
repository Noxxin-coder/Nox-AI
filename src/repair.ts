export interface RepairLoopOptions<T> {
  maxAttempts?: number;
  shouldStop?: (value: T) => boolean;
  onAttempt?: (attempt: number, value: T | undefined) => void;
}

export async function boundedRepairLoop<T>(
  task: (attempt: number) => Promise<T>,
  options: RepairLoopOptions<T> = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const shouldStop = options.shouldStop ?? (() => false);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await task(attempt);
    options.onAttempt?.(attempt, result);

    if (shouldStop(result)) {
      return result;
    }
  }

  throw new Error(`Repair loop exhausted after ${maxAttempts} attempts.`);
}
