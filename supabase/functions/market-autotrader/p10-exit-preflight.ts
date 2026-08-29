export type P10ExitOrderPreflightResult<T> =
  | {
    ok: true;
    orderRow: T;
  }
  | {
    ok: false;
    error: string;
    failedAt: string;
    restoredOpen: boolean;
    restoreError: string | null;
  };

type P10ExitOrderPreflightOptions<T> = {
  createOrderRecord: () => Promise<T>;
  restoreOpen: (failure: { error: string; failedAt: string }) => Promise<boolean>;
  now?: () => Date;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persists the close-order intent before the caller is allowed to contact the exchange.
 * A failure in this scope therefore has a known side-effect boundary: no exchange order
 * submission has happened, so the EXITING claim may be safely compare-and-swap restored.
 */
export async function prepareP10ExitOrder<T>(
  options: P10ExitOrderPreflightOptions<T>,
): Promise<P10ExitOrderPreflightResult<T>> {
  try {
    return { ok: true, orderRow: await options.createOrderRecord() };
  } catch (error) {
    const message = errorMessage(error);
    const failedAt = (options.now || (() => new Date()))().toISOString();
    try {
      return {
        ok: false,
        error: message,
        failedAt,
        restoredOpen: await options.restoreOpen({ error: message, failedAt }),
        restoreError: null,
      };
    } catch (restoreError) {
      return {
        ok: false,
        error: message,
        failedAt,
        restoredOpen: false,
        restoreError: errorMessage(restoreError),
      };
    }
  }
}

export function p10ExitOrderRecordFailureMetadata(
  metadata: Record<string, unknown> | null | undefined,
  failure: { error: string; failedAt: string; identifier: string },
): Record<string, unknown> {
  const restored = { ...(metadata || {}) };
  delete restored.pending_exit_action;
  delete restored.pending_exit_reason;
  delete restored.pending_exit_at;
  delete restored.pending_exit_identifier;
  return {
    ...restored,
    p10_last_exit_order_record_failed_at: failure.failedAt,
    p10_last_exit_order_record_error: failure.error,
    p10_last_exit_order_record_identifier: failure.identifier,
  };
}
