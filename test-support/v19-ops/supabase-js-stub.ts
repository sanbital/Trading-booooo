// Offline-only import-map target for `deno check` in restricted environments.
// Production and CI continue to resolve the pinned esm.sh module.
export function createClient(..._args: unknown[]): any {
  throw new Error("TYPE_CHECK_STUB_ONLY");
}
