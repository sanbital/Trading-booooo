// A timed-out acquire may have committed on the server. The caller must fail closed and
// let the lease expire or be observed by the next scheduled cycle. An immediate retry
// during a DB incident doubles admission traffic and amplifies the outage.
export function transientDbError(error) {
  const message = String(error?.message ?? error);
  return /signal timed out|timeout|timed out|fetch failed|network|econn|socket|DATABASE\s+(?:429|5\d\d)/i.test(message);
}

export async function acquireCycleLease(rpc, { name, owner, ttlSeconds, timeoutMs }) {
  return await rpc(
    "acquire_trading_lease",
    { p_name: name, p_owner: owner, p_seconds: ttlSeconds },
    timeoutMs,
  ) === true;
}
