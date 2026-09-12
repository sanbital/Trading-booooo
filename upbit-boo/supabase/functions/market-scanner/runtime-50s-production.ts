// Static production wrapper for the stable scanner source.
// The stable scanner marks per-market coverage complete at 45 seconds and polls every 250ms.
// Suppress only those coverage-poll callbacks until 55 seconds after each socket opens,
// leaving the original source and all relative imports untouched. This guarantees that
// late first frames still receive at least 50 seconds before the collector may finish.
const nativeSetInterval = globalThis.setInterval.bind(globalThis);

globalThis.setInterval = ((
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): number => {
  if (Number(timeout) === 250 && typeof handler === "function") {
    const intervalStartedAt = Date.now();
    return nativeSetInterval((...callbackArgs: unknown[]) => {
      if (Date.now() - intervalStartedAt < 55_000) return;
      (handler as (...innerArgs: unknown[]) => void)(...callbackArgs);
    }, timeout, ...args);
  }
  return nativeSetInterval(handler, timeout, ...args);
}) as typeof globalThis.setInterval;

await import(
  "https://raw.githubusercontent.com/sanbital/Trading-booooo/5e1bedc2d37478a27c1fb6e371635de421aebc22/supabase/functions/market-scanner/index.ts"
);
