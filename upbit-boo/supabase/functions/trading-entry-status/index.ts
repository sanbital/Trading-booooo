type JsonRecord = Record<string, any>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUTOTRADE_TOKEN = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || "").trim();
const DASHBOARD_TOKEN = ((Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN")) || "").trim();
const DASHBOARD_ORIGIN = ((Deno.env.get("ALLOWED_ORIGINS") || "").split(",")[0] || "*").trim();
const REVISION = "4-ENTRY-STATUS-POSITION-PNL-REASONS";
const ACCEPTED_OUTCOMES = new Set(["ACCEPTED", "ORDERED", "ENTERED", "BUY"]);

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index++) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

function authorized(request: Request): boolean {
  const provided = (request.headers.get("x-autotrade-token") || "").trim();
  if (!provided) return false;
  return (AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, provided)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, provided));
}

const CORS_HEADERS = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
  "access-control-max-age": "86400",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function db(path: string): Promise<any[]> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "cache-control": "no-cache" },
    cache: "no-store",
  });
  const text = await response.text();
  let data: any = [];
  try { data = text ? JSON.parse(text) : []; } catch { data = text; }
  if (!response.ok) throw new Error(`database ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function accepted(row: JsonRecord): boolean {
  return ACCEPTED_OUTCOMES.has(String(row?.outcome || "").toUpperCase());
}

function classifyRejection(reasonValue: unknown): { reason: string; detail: string } {
  const raw = String(reasonValue || "").trim();
  const upper = raw.toUpperCase();
  if (upper.includes("IOC ENTRY NOT FILLED")) {
    return { reason: "IOC 주문 미체결", detail: "지정한 가격에서 즉시 체결되지 않아 진입을 취소했습니다." };
  }
  if (upper.includes("INSUFFICIENT ASK DEPTH")) {
    return { reason: "매도 호가 깊이 부족", detail: "진입 수량을 소화할 매도 호가가 충분하지 않았습니다." };
  }
  if (upper.includes("PREORDER_ASK_DEPTH_DROPPED")) {
    return { reason: "주문 직전 호가 약화", detail: "최종 재검증에서 매도 호가 깊이가 줄어 진입을 중단했습니다." };
  }
  if (upper.includes("SELL_PRESSURE_DOMINANT")) {
    return { reason: "매도 압력 우세", detail: "주문 직전 매도 압력이 매수 압력보다 강했습니다." };
  }
  if (upper.includes("BUY_PRESSURE_NOT_CONFIRMED") && upper.includes("REWARD_RISK_FAILED")) {
    return { reason: "매수 압력·손익비 미달", detail: "매수 우위가 약했고 예상 손익비도 기준을 통과하지 못했습니다." };
  }
  if (upper.includes("BUY_PRESSURE_NOT_CONFIRMED")) {
    return { reason: "매수 압력 확인 부족", detail: "공격 매수 우위가 재검증 단계에서 확인되지 않았습니다." };
  }
  if (upper.includes("REWARD_RISK_FAILED")) {
    return { reason: "손익비 기준 미달", detail: "예상 보상 대비 손실 위험이 허용 기준보다 불리했습니다." };
  }
  if (upper.includes("M1_")) {
    return { reason: "1분봉 모멘텀 조건 미달", detail: "직전 1분봉의 상승·추세 조건이 충분하지 않았습니다." };
  }
  if (upper.includes("SPREAD")) {
    return { reason: "스프레드 과다", detail: "매수·매도 호가 차이가 커서 비용 기준을 통과하지 못했습니다." };
  }
  if (upper.includes("STALE") || upper.includes("BOOK_AGE")) {
    return { reason: "시세 데이터 지연", detail: "호가 데이터가 충분히 최신 상태가 아니었습니다." };
  }
  if (upper.includes("EV") || upper.includes("EXPECTED_VALUE")) {
    return { reason: "기대수익 기준 미달", detail: "비용을 반영한 기대수익이 최소 진입 기준보다 낮았습니다." };
  }
  if (upper.includes("DEPTH")) {
    return { reason: "호가 깊이 부족", detail: "주문을 안정적으로 소화할 호가 유동성이 부족했습니다." };
  }
  if (upper.includes("PRESSURE")) {
    return { reason: "호가 압력 조건 미달", detail: "매수 우위가 진입 기준만큼 강하지 않았습니다." };
  }
  const compact = raw.replace(/^LOB (final pre-order check|recheck):\s*/i, "").replaceAll("_", " ");
  return {
    reason: "기타 진입 조건 미달",
    detail: compact ? compact.slice(0, 120) : "세부 진입 조건을 통과하지 못했습니다.",
  };
}

function buildOpenPositions(positionRows: JsonRecord[], snapshotRows: JsonRecord[]): JsonRecord[] {
  const snapshots = new Map<string, JsonRecord>();
  for (const snapshot of snapshotRows) {
    const exchange = String(snapshot?.exchange || "").toLowerCase();
    if (exchange && !snapshots.has(exchange)) snapshots.set(exchange, snapshot);
  }

  return positionRows
    .map((row) => {
      const exchange = String(row.exchange || "").toLowerCase();
      const snapshot = snapshots.get(exchange) || {};
      const quantity = Math.max(0, finite(row.remaining_quantity), finite(row.reserved_quantity));
      const entryPrice = finite(row.average_entry_price, finite(row.planned_entry_price));
      const currentPrice = finite(snapshot?.prices?.[row.market], 0);
      const costQuote = quantity > 0 && entryPrice > 0 ? quantity * entryPrice : 0;
      const marketValueQuote = quantity > 0 && currentPrice > 0 ? quantity * currentPrice : 0;
      const initialQuantity = Math.max(quantity, finite(row.initial_quantity, quantity));
      const feeShare = initialQuantity > 0
        ? Math.max(0, finite(row.paid_fees_quote)) * Math.min(1, quantity / initialQuantity)
        : 0;
      const exitFeeRate = exchange === "upbit" ? 0.0005 : 0.001;
      const estimatedExitFee = marketValueQuote * exitFeeRate;
      const estimatedPnl = currentPrice > 0 && entryPrice > 0
        ? marketValueQuote - costQuote - feeShare - estimatedExitFee
        : null;
      const estimatedReturn = estimatedPnl !== null && costQuote > 0
        ? estimatedPnl / costQuote * 100
        : null;
      return {
        id: row.id,
        exchange,
        quote_currency: row.quote_currency || (exchange === "upbit" ? "KRW" : "USDT"),
        market: row.market,
        state: row.state,
        is_paper: Boolean(row.is_paper),
        opened_at: row.opened_at,
        quantity,
        entry_price: entryPrice || null,
        current_price: currentPrice || null,
        cost_quote: costQuote || null,
        market_value_quote: marketValueQuote || null,
        estimated_pnl_quote: estimatedPnl,
        estimated_return_pct: estimatedReturn,
        estimated_exit_fee_quote: estimatedExitFee || null,
        target_1: finite(row.target_1) || null,
        stop_price: finite(row.stop_price) || null,
        price_captured_at: snapshot.captured_at || null,
        exchange_unrealized_pnl_quote: snapshot.bot_unrealized_pnl_quote ?? null,
      };
    })
    .filter((row) => row.quantity > 0);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return reply({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return reply({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return reply({ ok: false, error: "missing Supabase configuration" }, 500);

  try {
    const settingsRows = await db(
      "trading_settings?id=eq.1&select=mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,last_full_scan_at,last_monitor_at,last_gateway_heartbeat_at,gateway_error_count,updated_at&limit=1",
    );
    const settings = settingsRows[0] || {};
    const lastScanAt = settings.last_full_scan_at || null;
    const scanCutoff = lastScanAt ? new Date(new Date(lastScanAt).getTime() - 20_000).toISOString() : new Date(Date.now() - 120_000).toISOString();
    const recentCutoff = new Date(Date.now() - 30 * 60_000).toISOString();

    const [latestDecisionRows, scanDecisionRows, recentDecisionRows, lastOrderRows, openPositionRows, snapshotRows] = await Promise.all([
      db("trading_decisions?select=created_at,cycle_id,exchange,market,outcome,reason&order=created_at.desc&limit=1"),
      db(`trading_decisions?created_at=gte.${encodeURIComponent(scanCutoff)}&select=created_at,cycle_id,exchange,market,outcome,reason&order=created_at.desc&limit=200`),
      db(`trading_decisions?created_at=gte.${encodeURIComponent(recentCutoff)}&select=created_at,exchange,market,outcome,reason&order=created_at.desc&limit=500`),
      db("trading_orders?select=requested_at,exchange,market,side,state,exchange_order_id&order=requested_at.desc&limit=1"),
      db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,exchange,quote_currency,market,state,is_paper,initial_quantity,remaining_quantity,reserved_quantity,average_entry_price,planned_entry_price,paid_fees_quote,target_1,stop_price,t1_completed,opened_at&order=opened_at.desc&limit=30"),
      db("trading_account_snapshots?select=exchange,captured_at,prices,bot_unrealized_pnl_quote&order=captured_at.desc&limit=12"),
    ]);

    const rejectedRecentRows = recentDecisionRows.filter((row) => !accepted(row));
    const reasonCounts = new Map<string, { count: number; detail: string }>();
    for (const row of rejectedRecentRows) {
      const classified = classifyRejection(row.reason || row.outcome);
      const current = reasonCounts.get(classified.reason) || { count: 0, detail: classified.detail };
      current.count += 1;
      reasonCounts.set(classified.reason, current);
    }
    const topReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([reason, value]) => ({ reason, count: value.count, detail: value.detail }));

    const acceptedSinceScan = scanDecisionRows.filter(accepted);
    const rejectedSinceScan = scanDecisionRows.filter((row) => !accepted(row));
    const blocked = Boolean(
      settings.pause_new_entries || settings.withdrawal_mode || settings.manual_intervention_required ||
      settings.scalp_kill_switch || settings.mode === "PAUSED"
    );

    let state = "RUNNING_WAITING";
    let message = "자동매매 정상 가동 · 현재 진입 조건 충족 종목 없음";
    if (blocked) {
      state = "BLOCKED";
      message = "신규 진입 차단 상태";
    } else if (acceptedSinceScan.length) {
      state = "ENTRY_FOUND";
      message = `이번 스캔에서 진입 승인 ${acceptedSinceScan.length}건`;
    } else if (scanDecisionRows.length) {
      state = "REJECTED_WAITING";
      message = `이번 스캔 후보 ${scanDecisionRows.length}건 중 ${rejectedSinceScan.length}건 조건 미충족`;
    }

    const latestDecision = latestDecisionRows[0] || null;
    const latestDecisionPayload = latestDecision
      ? {
          ...latestDecision,
          reason_label: accepted(latestDecision) || !latestDecision.reason
            ? null
            : classifyRejection(latestDecision.reason).reason,
        }
      : null;

    return reply({
      ok: true,
      revision: REVISION,
      generated_at: new Date().toISOString(),
      state,
      message,
      last_scan_at: lastScanAt,
      last_monitor_at: settings.last_monitor_at || null,
      last_gateway_heartbeat_at: settings.last_gateway_heartbeat_at || null,
      gateway_error_count: Number(settings.gateway_error_count || 0),
      latest_decision: latestDecisionPayload,
      decisions_since_scan: scanDecisionRows.length,
      accepted_since_scan: acceptedSinceScan.length,
      rejected_since_scan: rejectedSinceScan.length,
      recent_30m_decisions: recentDecisionRows.length,
      recent_30m_rejections: rejectedRecentRows.length,
      top_rejection_reasons_30m: topReasons,
      last_order: lastOrderRows[0] || null,
      open_positions: buildOpenPositions(openPositionRows, snapshotRows),
      controls: {
        mode: settings.mode || null,
        pause_new_entries: Boolean(settings.pause_new_entries),
        withdrawal_mode: Boolean(settings.withdrawal_mode),
        manual_intervention_required: Boolean(settings.manual_intervention_required),
        scalp_kill_switch: Boolean(settings.scalp_kill_switch),
      },
    });
  } catch (error) {
    return reply({ ok: false, revision: REVISION, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
