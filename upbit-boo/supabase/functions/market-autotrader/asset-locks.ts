// v6.10 asset-lock state machine. Query failures never erase accumulated clean evidence.

export type AssetLockCheck = "CLEAN" | "MISMATCH" | "QUERY_FAILED";
export interface AssetLockState {
  cleanChecks: number;
  state: "LOCKED" | "RELEASED";
}
export function nextAssetLockState(
  current: AssetLockState,
  check: AssetLockCheck,
  requiredCleanChecks = 3,
): AssetLockState {
  if (current.state === "RELEASED") return current;
  if (check === "QUERY_FAILED") return current;
  if (check === "MISMATCH") return { state: "LOCKED", cleanChecks: 0 };
  const cleanChecks = Math.max(0, current.cleanChecks) + 1;
  return cleanChecks >= Math.max(1, requiredCleanChecks)
    ? { state: "RELEASED", cleanChecks }
    : { state: "LOCKED", cleanChecks };
}
