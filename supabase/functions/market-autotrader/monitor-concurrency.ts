/**
 * Run independent position checks concurrently while preserving input order.
 *
 * Monitor decisions are isolated by position and every exchange side effect is protected by
 * the position's atomic OPEN -> EXITING claim.  Waiting for one market before even pricing the
 * next made the effective safety cadence grow linearly with the number of open positions.
 */
export const P10_MONITOR_POSITION_CONCURRENCY = 3;\n\nexport async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 2,
): Promise<R[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}
