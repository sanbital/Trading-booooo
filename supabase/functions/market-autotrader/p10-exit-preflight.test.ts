import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { p10ExitOrderRecordFailureMetadata, prepareP10ExitOrder } from "./p10-exit-preflight.ts";

Deno.test("P10 exit order-record fault restores the claimed position before gateway scope", async () => {
  let restoreCalls = 0;
  const result = await prepareP10ExitOrder({
    createOrderRecord: () => Promise.reject(new Error("injected order insert failure")),
    restoreOpen: ({ error, failedAt }) => {
      restoreCalls += 1;
      assertEquals(error, "injected order insert failure");
      assertEquals(failedAt, "2026-08-29T12:34:56.000Z");
      return Promise.resolve(true);
    },
    now: () => new Date("2026-08-29T12:34:56.000Z"),
  });

  assertEquals(restoreCalls, 1);
  assert(!result.ok);
  assertEquals(result.restoredOpen, true);
  assertEquals(result.restoreError, null);
  assertEquals(result.error, "injected order insert failure");
});

Deno.test("P10 exit order-record success never releases the EXITING claim", async () => {
  let restoreCalls = 0;
  const orderRow = { id: "order-1" };
  const result = await prepareP10ExitOrder({
    createOrderRecord: () => Promise.resolve(orderRow),
    restoreOpen: () => {
      restoreCalls += 1;
      return Promise.resolve(true);
    },
  });

  assert(result.ok);
  assertEquals(result.orderRow, orderRow);
  assertEquals(restoreCalls, 0);
});

Deno.test("P10 pre-gateway restore failure is reported without pretending OPEN recovery", async () => {
  const result = await prepareP10ExitOrder({
    createOrderRecord: () => Promise.reject("insert unavailable"),
    restoreOpen: () => Promise.reject(new Error("CAS unavailable")),
    now: () => new Date("2026-08-29T12:34:56.000Z"),
  });

  assert(!result.ok);
  assertEquals(result.restoredOpen, false);
  assertEquals(result.restoreError, "CAS unavailable");
  assertEquals(result.error, "insert unavailable");
});

Deno.test("OPEN recovery removes pending-exit ownership while retaining audit metadata", () => {
  const metadata = p10ExitOrderRecordFailureMetadata(
    {
      existing_key: "preserved",
      pending_exit_action: "STOP",
      pending_exit_reason: "REGIME_CHANGE",
      pending_exit_at: "2026-08-29T12:30:00.000Z",
      pending_exit_identifier: "tb-p10x-old",
    },
    {
      error: "injected order insert failure",
      failedAt: "2026-08-29T12:34:56.000Z",
      identifier: "tb-p10x-new",
    },
  );

  assertEquals(metadata.existing_key, "preserved");
  assertEquals("pending_exit_action" in metadata, false);
  assertEquals("pending_exit_reason" in metadata, false);
  assertEquals("pending_exit_at" in metadata, false);
  assertEquals("pending_exit_identifier" in metadata, false);
  assertEquals(metadata.p10_last_exit_order_record_error, "injected order insert failure");
  assertEquals(metadata.p10_last_exit_order_record_identifier, "tb-p10x-new");
});

Deno.test("P10 exit source keeps rollback inside the pre-exchange side-effect boundary", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const helperSource = await Deno.readTextFile(
    new URL("./p10-exit-preflight.ts", import.meta.url),
  );
  const start = source.indexOf("async function executeP10Exit(");
  const end = source.indexOf("async function monitorP10Positions(", start);
  assert(start >= 0 && end > start);
  const executeSource = source.slice(start, end);

  const claim = executeSource.indexOf("const claimed = await patch");
  const preflight = executeSource.indexOf("const preGatewayOrder = await prepareP10ExitOrder");
  const failureGate = executeSource.indexOf("if (!preGatewayOrder.ok)");
  const orderReady = executeSource.indexOf("const orderRow = preGatewayOrder.orderRow");
  const exchangeCreate = executeSource.indexOf("const payload = await gateway");
  assert(
    claim >= 0 && claim < preflight && preflight < failureGate && failureGate < orderReady &&
      orderReady < exchangeCreate,
  );

  const rollbackScope = executeSource.slice(preflight, failureGate);
  assert(rollbackScope.includes("id=eq.${position.id}&state=eq.EXITING"));
  assert(rollbackScope.includes("metadata->>pending_exit_at=eq."));
  assert(rollbackScope.includes('state: "OPEN"'));
  assert(rollbackScope.includes("p10ExitOrderRecordFailureMetadata"));

  const failureScope = executeSource.slice(failureGate, orderReady);
  assert(failureScope.includes("exchange_submission_attempted: false"));
  assert(failureScope.includes("pending_reconcile: !preGatewayOrder.restoredOpen"));
  assertEquals(failureScope.includes("gateway("), false);
  assertEquals(helperSource.includes("gateway("), false);
});
