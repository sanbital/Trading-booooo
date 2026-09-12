import { clamp, type FinalCandidate } from "./engine.ts";

export type SourceExchange = "upbit" | "binance";

export type VenueSummary = {
  exchange: SourceExchange;
  exchange_label: string;
  market: string;
  decision: FinalCandidate["decision"];
  decision_label: string;
  score: number;
  confidence: number;
  dynamic_status: string;
  dynamic_label: string;
};

export type CombinedCandidate = FinalCandidate & {
  source_exchange: SourceExchange;
  source_exchange_label: string;
  base_asset: string;
  combined_score: number;
  cross_exchange: {
    compared: boolean;
    aligned: boolean;
    conflict: boolean;
    both_buy: boolean;
    label: string;
    venues: VenueSummary[];
  };
};

const DYNAMIC_RISK = new Set([
  "SPOOF_LIKE_RISK",
  "ASK_ABSORPTION_RISK",
  "SUPPORT_BREAKDOWN_RISK",
]);

export function baseAsset(market: string, exchange: SourceExchange): string {
  const raw = exchange === "upbit"
    ? String(market).toUpperCase().replace(/^KRW-/, "")
    : String(market).toUpperCase().replace(/USDT$/, "");
  // Binance의 1000SHIB처럼 계약/표시 단위만 1,000배인 현물 심볼을
  // 업비트의 기초자산과 교차확인할 때만 같은 그룹으로 취급한다.
  return raw.replace(/^1000(?=[A-Z])/, "");
}

function decisionPriority(candidate: FinalCandidate): number {
  if (candidate.decision === "BUY") return 3;
  if (candidate.decision === "WAIT" && candidate.watch_entry_plan?.available) {
    return 2;
  }
  if (candidate.decision === "WAIT") return 1;
  return 0;
}

function betterCandidate(left: FinalCandidate, right: FinalCandidate): boolean {
  return decisionPriority(left) > decisionPriority(right) ||
    (decisionPriority(left) === decisionPriority(right) &&
      (left.score > right.score ||
        (left.score === right.score && left.confidence > right.confidence)));
}

function dynamicRisk(candidate: FinalCandidate): boolean {
  return DYNAMIC_RISK.has(candidate.microstructure?.dynamic?.status || "");
}

function venueSummary(
  candidate: FinalCandidate,
  exchange: SourceExchange,
): VenueSummary {
  return {
    exchange,
    exchange_label: exchange === "upbit" ? "업비트" : "바이낸스",
    market: candidate.market,
    decision: candidate.decision,
    decision_label: candidate.decision_label,
    score: candidate.score,
    confidence: candidate.confidence,
    dynamic_status: candidate.microstructure?.dynamic?.status || "UNKNOWN",
    dynamic_label: candidate.microstructure?.dynamic?.label || "동적 판정 없음",
  };
}

function cloneCandidate(candidate: FinalCandidate): FinalCandidate {
  return {
    ...candidate,
    trade_plan: { ...candidate.trade_plan },
    watch_entry_plan: {
      ...candidate.watch_entry_plan,
      conditions: [...(candidate.watch_entry_plan?.conditions || [])],
      scenario: [...(candidate.watch_entry_plan?.scenario || [])],
    },
    gates: [...(candidate.gates || [])],
    failed_gates: [...(candidate.failed_gates || [])],
    positives: [...(candidate.positives || [])],
    negatives: [...(candidate.negatives || [])],
    warnings: [...(candidate.warnings || [])],
  };
}

export function combineCandidates(
  upbit: FinalCandidate[],
  binance: FinalCandidate[],
  limit = 4,
): CombinedCandidate[] {
  const grouped = new Map<
    string,
    Array<{ exchange: SourceExchange; candidate: FinalCandidate }>
  >();
  for (
    const [exchange, candidates] of [
      ["upbit", upbit],
      ["binance", binance],
    ] as const
  ) {
    for (const candidate of candidates || []) {
      const asset = baseAsset(candidate.market, exchange);
      const rows = grouped.get(asset) || [];
      const sameVenue = rows.findIndex((row) => row.exchange === exchange);
      if (sameVenue >= 0) {
        if (betterCandidate(candidate, rows[sameVenue].candidate)) {
          rows[sameVenue] = { exchange, candidate };
        }
      } else rows.push({ exchange, candidate });
      grouped.set(asset, rows);
    }
  }

  const combined: CombinedCandidate[] = [];
  for (const [asset, rows] of grouped) {
    rows.sort((left, right) =>
      decisionPriority(right.candidate) - decisionPriority(left.candidate) ||
      right.candidate.score - left.candidate.score ||
      right.candidate.confidence - left.candidate.confidence
    );
    const representative = cloneCandidate(rows[0].candidate);
    const source = rows[0].exchange;
    const venues = rows.map((row) => venueSummary(row.candidate, row.exchange));
    const compared = rows.length > 1;
    const bothBuy = compared &&
      rows.every((row) =>
        row.candidate.decision === "BUY" && !dynamicRisk(row.candidate)
      );
    const aligned = compared &&
      rows.every((row) =>
        row.candidate.decision !== "AVOID" && !dynamicRisk(row.candidate)
      );
    const counterpartRisk = rows.slice(1).some((row) =>
      row.candidate.decision === "AVOID" || dynamicRisk(row.candidate)
    );
    const conflict = representative.decision === "BUY" && counterpartRisk;

    if (conflict) {
      representative.decision = "WAIT";
      representative.decision_label = "교차거래소 충돌·진입 보류";
      representative.trade_plan.actionable = false;
      representative.gates.push({
        key: "cross_exchange",
        label: "교차거래소 확인",
        passed: false,
        detail:
          "다른 거래소의 동일 기초자산에서 회피 또는 동적 호가 위험이 탐지되어 현재가 진입을 보류합니다.",
      });
      representative.failed_gates.push("cross_exchange");
      representative.warnings.push(
        "교차거래소 충돌: 다른 거래소에서 회피 또는 동적 호가 위험이 확인됐습니다.",
      );
    }

    const meanScore = rows.reduce((sum, row) => sum + row.candidate.score, 0) /
      rows.length;
    const confirmationAdjustment = bothBuy
      ? 3
      : aligned
      ? 1
      : conflict
      ? -10
      : 0;
    const combinedScore = clamp(
      representative.score * (compared ? 0.7 : 1) +
        meanScore * (compared ? 0.3 : 0) + confirmationAdjustment,
      0,
      100,
    );
    const label = !compared
      ? `${source === "upbit" ? "업비트" : "바이낸스"} 단독 최종 후보`
      : conflict
      ? "양 거래소 신호 충돌 · 매수 보류"
      : bothBuy
      ? "업비트·바이낸스 BUY 동시 확인"
      : aligned
      ? "양 거래소 방향 일치 · 조건 확인"
      : "양 거래소 비교 완료";

    combined.push({
      ...representative,
      source_exchange: source,
      source_exchange_label: source === "upbit" ? "업비트" : "바이낸스",
      base_asset: asset,
      combined_score: combinedScore,
      cross_exchange: {
        compared,
        aligned,
        conflict,
        both_buy: bothBuy,
        label,
        venues,
      },
    });
  }

  return combined
    .filter((candidate) => candidate.decision !== "AVOID")
    .sort((left, right) => {
      const priority = decisionPriority(right) - decisionPriority(left);
      if (priority) return priority;
      const confirmationLeft = left.cross_exchange.both_buy
        ? 3
        : left.cross_exchange.aligned
        ? 2
        : left.cross_exchange.compared
        ? 1
        : 0;
      const confirmationRight = right.cross_exchange.both_buy
        ? 3
        : right.cross_exchange.aligned
        ? 2
        : right.cross_exchange.compared
        ? 1
        : 0;
      return right.combined_score - left.combined_score ||
        confirmationRight - confirmationLeft ||
        right.confidence - left.confidence;
    })
    .slice(0, Math.max(1, limit))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
