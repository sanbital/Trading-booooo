// A timed-out acquire may have committed on the server. Always retry with the same owner.
export function transientDbError(error) {
  const message = String(error?.message ?? error);
  return /signal timed out|timeout|timed out|fetch failed|network|econn|socket|DATABASE\s+(?:429|5\d\d)/i.test(message);
}

export async function acquireCycleLease(rpc, { name, owner, ttlSeconds, timeoutMs, waitMs = 120, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  try {
    return await rpc("acquire_trading_lease", { p_name: name, p_owner: owner, p_seconds: ttlSeconds }, timeoutMs) === true;
  } catch (error) {
    if (!transientDbError(error)) throw error;
    await sleep(waitMs);
    // False means another owner holds the lease. Never retry that business result.
    // An exception here leaves lease ownership unconfirmed: callers must not trade.
    return await rpc("acquire_trading_lease", { p_name: name, p_owner: owner, p_seconds: ttlSeconds }, timeoutMs) === true;
  }
}
