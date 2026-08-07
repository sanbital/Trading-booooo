type JsonRecord = Record<string, any>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUTOTRADE_TOKEN = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || "").trim();
const DASHBOARD_TOKEN = ((Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN")) || "").trim();
const DASHBOARD_ORIGIN = ((Deno.env.get("ALLOWED_ORIGINS") || "").split(",")[0] || "*").trim();
const REVISION = "1-ENTRY-DECISION-STATUS";

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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return reply({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return reply({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return reply({ ok: false, error: "missing Supabase configuration" }, 500);

  try {
    const settingsRows = await db(
      "trading_operator_settings?select=mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,last_full_scan_at,last_monitor_at,last_gateway_heartbeat_at,gateway_error_count,updated_at&order=id.asc&limit=1",
    );
    const settings = settingsRows[0] || {};
    const lastScanAt = settings.last_full_scan_at || null;
    const scanCutoff = lastScanAt ? new Date(new Date(lastScanAt).getTime() - 20_000).toISOString() : new Date(Date.now() - 120_000).toISOString();
    const recentCutoff = new Date(Date.now() - 30 * 60_000).toISOString();

    const [latestDecisionRows, scanDecisionRows, recentDecisionRows, lastOrderRows] = await Promise.all([
      db("trading_decisions?select=created_at,cycle_id,exchange,market,outcome,reason&order=created_at.desc&limit=1"),
      db(`trading_decisions?created_at=gte.${encodeURIComponent(scanCutoff)}&select=created_at,cycle_id,exchange,market,outcome,reason&order=created_at.desc&limit=200`),
      db(`trading_decisions?created_at=gte.${encodeURIComponent(recentCutoff)}&select=created_at,exchange,market,outcome,reason&order=created_at.desc&limit=500`),
      db("trading_orders?select=requested_at,exchange,market,side,status,exchange_order_id&order=requested_at.desc&limit=1"),
    ]);

    const reasonCounts = new Map<string, number>();
    for (const row of recentDecisionRows) {
      const reason = String(row.reason || row.outcome || "UNKNOWN");
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const topReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([reason, count]) => ({ reason, count }));

    const acceptedSinceScan = scanDecisionRows.filter((row) => ["ACCEPTED", "ORDERED", "ENTERED", "BUY"].includes(String(row.outcome || "").toUpperCase()));
    const rejectedSinceScan = scanDecisionRows.filter((row) => !acceptedSinceScan.includes(row));
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
      message = `이번 스캔 후보 ${scanDecisionRows.length}건 모두 조건 미충족`;
    }

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
      latest_decision: latestDecisionRows[0] || null,
      decisions_since_scan: scanDecisionRows.length,
      accepted_since_scan: acceptedSinceScan.length,
      rejected_since_scan: rejectedSinceScan.length,
      recent_30m_decisions: recentDecisionRows.length,
      top_rejection_reasons_30m: topReasons,
      last_order: lastOrderRows[0] || null,
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
