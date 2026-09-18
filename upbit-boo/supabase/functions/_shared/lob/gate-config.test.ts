import {
  buildLobGateConfig,
  LOB_DEFAULT_MAX_GAINER_RANK,
  LOB_MIN_NET_REWARD_RISK_RATIO,
} from "./gate-config.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const defaults = { maxSpreadBps: 30 };

Deno.test("an operator cannot lower the reward-risk floor below the executor's", () => {
  // This is the divergence that produced stored BUY candidates with no trades: the scanner
  // passed the operator value straight through while the executor floored it at 1.5, so a
  // relaxed setting made the two stages disagree on every candidate in between.
  for (const attempted of [0.004, 0.1, 0.25, 0.75, 1.49]) {
    const cfg = buildLobGateConfig({ minNetRewardRiskRatio: attempted }, defaults);
    assert(
      cfg.minNetRewardRiskRatio === LOB_MIN_NET_REWARD_RISK_RATIO,
      `a ${attempted} reward-risk floor must be raised to ${LOB_MIN_NET_REWARD_RISK_RATIO}`,
    );
  }
});

Deno.test("an operator can still tighten the reward-risk floor", () => {
  assert(
    buildLobGateConfig({ minNetRewardRiskRatio: 2.5 }, defaults).minNetRewardRiskRatio === 2.5,
  );
  // And cannot push it past the point where nothing could ever qualify.
  assert(buildLobGateConfig({ minNetRewardRiskRatio: 99 }, defaults).minNetRewardRiskRatio === 5);
});

Deno.test("both stages derive an identical gate from identical settings", () => {
  const settings = {
    minNetRewardRiskRatio: 0.1,
    maxStopToTargetRatio: 4,
    maxGainerRank: 3,
    maxBookAgeMs: 2500,
    maxSpreadBps: 30,
    minNetProfitBps: 20,
  };
  const scanner = buildLobGateConfig(settings, defaults);
  const executor = buildLobGateConfig(settings, defaults);
  assert(
    JSON.stringify(scanner) === JSON.stringify(executor),
    "the scanner and the executor must not be able to disagree",
  );
});

Deno.test("missing settings fall back to the measured-safe gate", () => {
  const cfg = buildLobGateConfig({}, defaults);
  assert(cfg.minNetRewardRiskRatio === LOB_MIN_NET_REWARD_RISK_RATIO);
  // e473f42 widened the default admission rank from 3 to 10 with the 15s Top-10 composite
  // pressure release, and deploy-top10-15s-composite-pressure.yml pins the constant.
  // The fallback comes from LOB_DEFAULT_MAX_GAINER_RANK, not from `defaults`.
  assert(
    cfg.maxGainerRank === LOB_DEFAULT_MAX_GAINER_RANK,
    `expected the module default rank, got ${cfg.maxGainerRank}`,
  );
  assert(cfg.maxGainerRank === 10);
  assert(cfg.maxSpreadBps === 30);
  assert(cfg.minEvBps === 0, "EV has no measured relationship to outcome and stays advisory");
});

Deno.test("nonsense settings cannot widen the gate", () => {
  const cfg = buildLobGateConfig({
    minNetRewardRiskRatio: Number.NaN,
    maxStopToTargetRatio: Number.POSITIVE_INFINITY,
    maxGainerRank: 999,
    maxBookAgeMs: -1,
    maxSpreadBps: 0,
  }, defaults);
  assert(cfg.minNetRewardRiskRatio === LOB_MIN_NET_REWARD_RISK_RATIO);
  // Non-finite input is not a value to clamp — it falls back to the default rather than
  // resolving to the loosest end of the band.
  assert(cfg.maxStopToTargetRatio === 1.35);
  assert(cfg.maxGainerRank === 10);
  assert(cfg.maxBookAgeMs === 250);
  assert(cfg.maxSpreadBps === 1);

  // A finite but absurd value is clamped to the ceiling instead.
  assert(
    buildLobGateConfig({ maxStopToTargetRatio: 999 }, defaults).maxStopToTargetRatio === 5,
  );
});
