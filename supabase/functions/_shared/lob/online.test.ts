import {
  onlineAdverseEvPenaltyBps,
  type LobOnlineProfileRow,
  resolveLobOnlineMarketPolicy,
} from "./online.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function row(overrides: Partial<LobOnlineProfileRow> = {}): LobOnlineProfileRow {
  return {
    exchange: "upbit",
    market: "*",
    pattern: "SWEEP_RECLAIM",
    version: 20,
    samples: 20,
    profitable_trades: 8,
    target_hits: 5,
    early_exit_losses: 3,
    ewma_net_bps: 4,
    ewma_hold_seconds: 42,
    ewma_profitable_hold_seconds: 50,
    ewma_mae_bps: 18,
    ewma_mfe_bps: 40,
    ewma_profitable_mae_bps: 14,
    ...overrides,
  };
}

Deno.test("an unseen coin inherits its exchange-pattern parent without a hard veto", () => {
  const policy = resolveLobOnlineMarketPolicy(
    [row()],
    "upbit",
    "KRW-EUL",
    "SWEEP_RECLAIM",
  );
  assert(policy.source === "PATTERN");
  assert(policy.globalSamples === 20);
  assert(policy.marketSamples === 0);
  assert(policy.profitableRate === 0.4);
  assert(policy.rankingQuality > 0);
});

Deno.test("coin evidence is hierarchically shrunk instead of overfitting one trade", () => {
  const policy = resolveLobOnlineMarketPolicy(
    [
      row(),
      row({
        market: "KRW-EUL",
        version: 2,
        samples: 2,
        profitable_trades: 0,
        target_hits: 0,
        early_exit_losses: 2,
        ewma_net_bps: -35,
      }),
    ],
    "upbit",
    "KRW-EUL",
    "SWEEP_RECLAIM",
  );
  assert(policy.source === "MARKET");
  assert(policy.profitableRate! > 0, "two losses must not erase the parent prior");
  assert(policy.profitableRate! < 0.4, "coin losses must still lower priority");
  assert(policy.softExitConfirmations === 4);
});

Deno.test("adverse EV correction is silent for unseen and immature markets", () => {
  assert(onlineAdverseEvPenaltyBps({ marketSamples: 0, meanNetBps: -50 }) === 0);
  assert(onlineAdverseEvPenaltyBps({ marketSamples: 7, meanNetBps: -50 }) === 0);
  assert(onlineAdverseEvPenaltyBps({ marketSamples: 40, meanNetBps: 5 }) === 0);
});

Deno.test("mature fee-net market losses reduce admission EV without a trade-count cap", () => {
  const penalty = onlineAdverseEvPenaltyBps({ marketSamples: 29, meanNetBps: -24 }, 30);
  assert(penalty > 15 && penalty < 17);
  assert(onlineAdverseEvPenaltyBps({ marketSamples: 80, meanNetBps: -90 }, 30) === 30);
});

Deno.test("winner adverse excursion learns a stop floor only after enough successes", () => {
  const mature = resolveLobOnlineMarketPolicy(
    [
      row({
        market: "KRW-EUL",
        samples: 12,
        profitable_trades: 5,
        ewma_profitable_mae_bps: 25,
      }),
    ],
    "upbit",
    "KRW-EUL",
    "SWEEP_RECLAIM",
  );
  assert(Math.abs(mature.learnedStopFloorBps - 30) < 1e-9);

  const immature = resolveLobOnlineMarketPolicy(
    [
      row({
        market: "KRW-EUL",
        samples: 4,
        profitable_trades: 4,
        ewma_profitable_mae_bps: 25,
      }),
    ],
    "upbit",
    "KRW-EUL",
    "SWEEP_RECLAIM",
  );
  assert(immature.learnedStopFloorBps === 0);
});

Deno.test("the prior policy confirms soft exits but never delays hard stops", () => {
  const policy = resolveLobOnlineMarketPolicy(
    [],
    "binance",
    "BTCUSDT",
    "OFI_CONTINUATION",
  );
  assert(policy.source === "PRIOR");
  assert(policy.softExitGraceSeconds === 6);
  assert(policy.softExitConfirmations === 2);
  assert(policy.learnedStopFloorBps === 0);
});
