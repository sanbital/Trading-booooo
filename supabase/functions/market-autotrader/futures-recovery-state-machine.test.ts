import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FUTURES_SPLIT_EXIT_THRESHOLDS,
  futuresRecoveryState,
  futuresSplitExitDecision,
} from "./futures-exit-policy.ts";

const ROOT = new URL("../../../", import.meta.url);
const ENGINE = await Deno.readTextFile(
  new URL("supabase/functions/market-autotrader/index.ts", ROOT),
);
const MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260818083500_futures_recovery_3m_state_machine.sql", ROOT),
);

Deno.test("Futures mission state is 3m RECOVERY, not 180m recovery", () => {
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.recoveryLatchAfterSeconds, 180);
  assertEquals(FUTURES_SPLIT_EXIT_THRESHOLDS.staleGivebackAfterSeconds, 10_800);

  const recovery = futuresRecoveryState({
    residualStage: false,
    alreadyLatched: false,
    heldSeconds: 180,
    netReturnPct: -0.01,
  });
  assertEquals(recovery, { enabled: true, newlyLatched: true });

  const exit = futuresSplitExitDecision({
    residualStage: false,
    recoveryMode: true,
    leverage: 3,
    grossReturnPct: 0.2,
    peakGrossReturnPct: 0.8,
    netReturnPct: 0.1,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.01,
    heldSeconds: 181,
  });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
  assertEquals(exit.reason, "FUTURES_RECOVERY_NET_POSITIVE_EXIT");
});

Deno.test("runtime and DB preserve the same permanent recovery state", () => {
  assert(ENGINE.includes("futuresRecoveryState({"));
  assert(ENGINE.includes('trigger_reason: "FUTURES_3M_NET_NONPOSITIVE"'));
  assert(ENGINE.includes('exit_rule: "FULL_POSITION_EXECUTABLE_NET_PNL_GT_0"'));
  assert(ENGINE.includes("position.t1_completed !== true"));
  assert(ENGINE.includes('decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT"'));

  assert(MIGRATION.includes("recovery_latch_after_seconds"));
  assert(MIGRATION.includes("FUTURES_RECOVERY_NET_POSITIVE_EXIT"));
  assert(MIGRATION.includes("FUTURES_RECOVERY_NOT_LATCHED"));
  assert(MIGRATION.includes("FUTURES_RECOVERY_REQUIRES_POSITIVE_NET"));
  assert(MIGRATION.includes("coalesce(new.t1_completed, false)"));
  assert(!MIGRATION.includes("new.t1_completed := v_residual_stage"));
  assert(!MIGRATION.includes("- 'recovery_exit'"));
});

Deno.test("generic LOB/scalp owners cannot terminate a Futures position", () => {
  assert(
    ENGINE.includes(
      "lobMode && !futuresLane && !settings.emergency_liquidation && heldSeconds >= 180",
    ),
  );
  assert(ENGINE.includes('lobMode && !futuresLane && decision.action === "NONE"'));
  assert(ENGINE.includes('scalpMode && !futuresLane && decision.action === "NONE"'));
  assert(
    ENGINE.includes("if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds)"),
  );
});
