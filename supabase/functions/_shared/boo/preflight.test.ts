// Section 10: "검증 미통과 상태에서는 활성화 도구도 실패하도록 구현하십시오.
//              환경변수 하나로 미승인 상태를 우회하지 못하게 하십시오."
//
// These tests prove that property by enumeration rather than asserting it in a
// comment: across every subset of failing checks, and across a set of inputs
// chosen to look like bypass attempts, liveReady is never true unless every
// check genuinely passes.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CHECK_IDS, evaluatePreflight } from "./preflight.mjs";
import { resolveRiskPolicy } from "./risk-policy.mjs";

const NOW = Date.parse("2026-09-16T14:00:00Z");

/** The only state that should ever yield liveReady. */
function passingState(): any {
  return {
    now: NOW,
    ledgerExceptions: [],
    riskPolicy: resolveRiskPolicy({ risk_per_trade_pct: 0.25, max_daily_loss_pct: 1 }),
    edge: { source: "MEASURED", netBps: 20, requiredBps: 15 },
    approvals: [{
      revoked: false,
      valid_until: "2099-01-01T00:00:00Z",
      net_expectancy_lower_bound: 0.5,
      expected_edge_source: "EVALUATED",
      approved_by: "operator:lkr9912",
    }],
    shadowClosedCount: 120,
    gateDecisionCount: 900,
    expectedExecutorSha: "a".repeat(64),
    deployedExecutorSha: "a".repeat(64),
    openPositionCount: 0,
    pendingOrderCount: 0,
  };
}

/** Mutations that break exactly one check. */
const BREAKERS: Record<string, (s: any) => void> = {
  ledger_reconciled: (s) => {
    s.ledgerExceptions = [{ symbol: "哈基미USDT", finding_code: "EXIT_FILLS_MISSING" }];
  },
  risk_config_valid: (s) => {
    s.riskPolicy = resolveRiskPolicy({ risk_per_trade_pct: 100, max_daily_loss_pct: 30 });
  },
  edge_measured: (s) => {
    s.edge = { source: "ASSUMED", netBps: 11, requiredBps: 15 };
  },
  strategy_approved: (s) => {
    s.approvals = [];
  },
  shadow_sample_present: (s) => {
    s.shadowClosedCount = 0;
  },
  gate_live: (s) => {
    s.gateDecisionCount = 0;
  },
  deployed_sha_pinned: (s) => {
    s.deployedExecutorSha = "b".repeat(64);
  },
  no_unsettled_state: (s) => {
    s.openPositionCount = 1;
  },
};

Deno.test("preflight: the fully passing state is the only one that yields live_ready", () => {
  const r = evaluatePreflight(passingState());
  assertEquals(r.liveReady, true, JSON.stringify(r.blocking));
  assertEquals(r.checks.length, CHECK_IDS.length);
});

Deno.test("preflight: breaking any single check blocks activation", () => {
  for (const [id, breaker] of Object.entries(BREAKERS)) {
    const s = passingState();
    breaker(s);
    const r = evaluatePreflight(s);
    assertEquals(r.liveReady, false, `${id} did not block`);
    assert(r.blocking.some((b: any) => b.id === id), `${id} not reported as blocking`);
    assert(r.blocking.every((b: any) => b.remedy), `${id} blocked without a remedy`);
  }
});

Deno.test("preflight: EVERY subset of broken checks blocks (2^8 enumeration)", () => {
  const ids = Object.keys(BREAKERS);
  for (let mask = 0; mask < (1 << ids.length); mask++) {
    const s = passingState();
    const broken: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (mask & (1 << i)) {
        BREAKERS[ids[i]](s);
        broken.push(ids[i]);
      }
    }
    const r = evaluatePreflight(s);
    assertEquals(
      r.liveReady,
      broken.length === 0,
      `mask ${mask} broken=[${broken.join(",")}] gave liveReady=${r.liveReady}`,
    );
  }
});

Deno.test("preflight: unknown state is a failure, never a pass", () => {
  // Missing inputs must not read as "nothing wrong".
  assertEquals(evaluatePreflight({}).liveReady, false);
  assertEquals(evaluatePreflight(null).liveReady, false);
  assertEquals(evaluatePreflight(undefined).liveReady, false);
  // An unreadable ledger is not a clean ledger.
  const s = passingState();
  s.ledgerExceptions = null;
  assertEquals(evaluatePreflight(s).liveReady, false);
});

Deno.test("preflight: extra keys that look like overrides change nothing", () => {
  // Anything an operator or a caller might hopefully add.
  const overrides = [
    { force: true },
    { bypass: true },
    { skipChecks: true },
    { SKIP_CHECKS: "1" },
    { liveReady: true },
    { blocking: [] },
    { checks: [] },
    { override: "approved" },
    { allow: true },
    { ignoreLedger: true },
  ];
  for (const extra of overrides) {
    const s = { ...passingState(), ...extra };
    s.shadowClosedCount = 0; // one genuine failure
    const r = evaluatePreflight(s);
    assertEquals(r.liveReady, false, `override ${JSON.stringify(extra)} let it through`);
  }
});

Deno.test("preflight: an approval cannot pass by being merely present", () => {
  const variants = [
    { revoked: true },
    { valid_until: "2020-01-01T00:00:00Z" },
    { net_expectancy_lower_bound: 0 },
    { net_expectancy_lower_bound: -1 },
    { expected_edge_source: "MANUAL" },
    { expected_edge_source: "OPERATOR" },
    { approved_by: null },
  ];
  for (const v of variants) {
    const s = passingState();
    s.approvals = [{ ...s.approvals[0], ...v }];
    const r = evaluatePreflight(s);
    assertEquals(r.liveReady, false, `approval variant ${JSON.stringify(v)} passed`);
  }
});

Deno.test("preflight: the live production configuration fails today", () => {
  // Exactly the state observed on 2026-09-16: implausible risk config, assumed
  // edge, unresolved ledger, no approval, gate never evaluated.
  const s = {
    now: NOW,
    ledgerExceptions: [
      { symbol: "哈基미USDT", finding_code: "EXIT_FILLS_MISSING" },
      { symbol: "ARKUSDT", finding_code: "EXIT_FILLS_MISSING" },
      { symbol: "CVCUSDT", finding_code: "NO_FILLS_LINKED" },
    ],
    riskPolicy: resolveRiskPolicy({
      risk_per_trade_pct: 100,
      max_daily_loss_pct: 30,
      max_consecutive_losses: 1000000,
    }),
    edge: { source: "ASSUMED", netBps: 11, requiredBps: 15 },
    approvals: [],
    shadowClosedCount: 0,
    gateDecisionCount: 0,
    expectedExecutorSha: "",
    deployedExecutorSha: "7575268e27e9b77c9ff463d8608c831d480203bc7bc05f3c3de97b7e5d17b6be",
    openPositionCount: 0,
    pendingOrderCount: 0,
  };
  const r = evaluatePreflight(s);
  assertEquals(r.liveReady, false);
  const blocked = r.blocking.map((b: any) => b.id).sort();
  assertEquals(blocked, [
    "deployed_sha_pinned",
    "edge_measured",
    "gate_live",
    "ledger_reconciled",
    "risk_config_valid",
    "shadow_sample_present",
    "strategy_approved",
  ]);
});
