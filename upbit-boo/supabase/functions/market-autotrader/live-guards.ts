import type { Exchange } from "./core.ts";
import type { LobPatternName } from "../_shared/lob/types.ts";

/**
 * Live-fill evidence: standalone momentum loses on both Binance lanes, while standalone
 * OFI loses on spot but the verified futures sample is still positive and too small to
 * justify a futures ban. Keep the venue split explicit so a future global default cannot
 * silently disable the futures lane.
 */
export function liveBlockedLobPatterns(exchange: Exchange): LobPatternName[] {
  return exchange === "binance"
    ? ["MOMENTUM_CONTINUATION", "OFI_CONTINUATION"]
    : ["MOMENTUM_CONTINUATION"];
}

export type PreT1ProfitProtectionInput = {
  hasTradableHalf: boolean;
  entryPrice: number;
  executableExitPrice: number;
  protectedStopPrice: number;
  executableNetAllowed: boolean;
  executableNetProfitQuote: number;
};

/**
 * Pre-T1 profit protection may liquidate the position only after a real positive floor
 * has been earned. Historical metadata can contain below-entry protective stops, which
 * must never become a new loss exit merely because the field exists.
 */
export function preT1ProfitProtectionHit(input: PreT1ProfitProtectionInput): boolean {
  const entry = Number(input.entryPrice);
  const exit = Number(input.executableExitPrice);
  const protectedStop = Number(input.protectedStopPrice);
  const executableNetProfit = Number(input.executableNetProfitQuote);
  return input.hasTradableHalf === true &&
    input.executableNetAllowed === true &&
    Number.isFinite(executableNetProfit) && executableNetProfit > 0 &&
    Number.isFinite(entry) && entry > 0 &&
    Number.isFinite(exit) && exit > 0 &&
    Number.isFinite(protectedStop) && protectedStop > entry &&
    exit <= protectedStop;
}
