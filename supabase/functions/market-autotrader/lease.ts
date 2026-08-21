/**
 * Coordination policy for the DB leases that serialise autotrader cycles.
 *
 * acquire_trading_lease folds `autotrader-scan` and `autotrader-monitor` onto one
 * `autotrader-engine` row, so scan and monitor contend for a single lease. Monitor runs a
 * 13-15s cycle every 2s, which leaves a scan that gives up after one failed acquisition
 * almost no chance of ever running. The helpers here hold the acquire/wait/renew decisions
 * so they can be tested without a database; the caller supplies the RPC calls.
 */
export interface LeaseGateway {
  /** Resolves true when this owner holds the lease. Renewing with the same owner refreshes it. */
  acquire(name: string, owner: string, ttlSeconds: number): Promise<boolean>;
  release(name: string, owner: string): Promise<unknown>;
}

export interface RenewedLeaseOptions {
  ttlSeconds: number;
  renewMs: number;
  /** Total time to keep re-attempting a busy lease before giving up. 0 attempts once. */
  waitMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` under a short-TTL lease that is renewed for as long as the work runs.
 *
 * The TTL is a heartbeat, not a runtime budget: an invocation that dies mid-flight frees the
 * shared lease within one TTL instead of blocking the other cycle for the caller's whole
 * worst-case runtime, while a live caller keeps the lease as long as it needs it.
 */
export async function runWithRenewedLease<T>(
  gateway: LeaseGateway,
  name: string,
  owner: string,
  options: RenewedLeaseOptions,
  work: () => Promise<T>,
): Promise<T | null> {
  if (await gateway.acquire(name, owner, options.ttlSeconds) !== true) return null;
  const renew = setInterval(() => {
    gateway.acquire(name, owner, options.ttlSeconds).catch(() => null);
  }, Math.max(1, options.renewMs));
  try {
    return await work();
  } finally {
    clearInterval(renew);
    await gateway.release(name, owner).catch(() => null);
  }
}

/**
 * Acquire a lease a long-running neighbour usually holds, waiting out one of its cycles.
 *
 * Waiting never delays the holder: whoever owns the lease keeps it until it is released, and
 * this only claims the idle gap left behind. `newOwner` is called per attempt so every
 * attempt is a distinct owner and a failed attempt can never renew someone else's lease.
 */
export async function runWithContendedLease<T>(
  gateway: LeaseGateway,
  name: string,
  newOwner: () => string,
  options: RenewedLeaseOptions,
  work: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T | null> {
  const pollMs = Math.max(1, options.pollMs ?? 2_000);
  const deadline = now() + Math.max(0, options.waitMs ?? 0);
  for (;;) {
    const result = await runWithRenewedLease(gateway, name, newOwner(), options, work);
    if (result != null) return result;
    if (now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}
