// Trading-booooo realtime trade email sender v1.1.0
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type Json = Record<string, unknown>;
const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const enc = new TextEncoder(), dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function response(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function rpc<T>(name: string, args: Json = {}): Promise<T> {
  if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_RUNTIME_CONFIG_MISSING");
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC_${name}_${res.status}:${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const num = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const compact = (v: unknown, digits = 8) => num(v).toFixed(digits).replace(/\.?0+$/, "");
const money = (v: unknown) => num(v).toFixed(2);
const signedMoney = (v: unknown) => `${num(v) >= 0 ? "+" : ""}${num(v).toFixed(4)}`;
const signedPct = (v: unknown) => `${num(v) >= 0 ? "+" : ""}${num(v).toFixed(2)}%`;
const bool = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

function kst(iso?: string) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} KST`;
}

function b64utf8(value: string) {
  const bytes = enc.encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

class Smtp {
  private buffer = "";
  constructor(private conn: Deno.TlsConn) {}

  private async line() {
    while (true) {
      const i = this.buffer.indexOf("\r\n");
      if (i >= 0) {
        const out = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 2);
        return out;
      }
      const chunk = new Uint8Array(4096);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("SMTP_CONNECTION_CLOSED");
      this.buffer += dec.decode(chunk.subarray(0, n), { stream: true });
      if (this.buffer.length > 65536) throw new Error("SMTP_RESPONSE_TOO_LARGE");
    }
  }

  async expect(...codes: number[]) {
    const lines: string[] = [];
    while (true) {
      const line = await this.line();
      lines.push(line);
      const m = line.match(/^(\d{3})([ -])/);
      if (!m || m[2] === "-") continue;
      const code = Number(m[1]);
      if (!codes.includes(code)) throw new Error(`SMTP_${code}:${lines.join(" | ").slice(0, 500)}`);
      return lines.join("\n");
    }
  }

  async command(command: string, ...codes: number[]) {
    await this.conn.write(enc.encode(`${command}\r\n`));
    return this.expect(...codes);
  }

  async message(raw: string) {
    await this.conn.write(enc.encode(`${raw}\r\n.\r\n`));
    return this.expect(250);
  }

  close() { try { this.conn.close(); } catch { /* noop */ } }
}

async function sendGmail(config: any, subject: string, body: string) {
  const user = String(config.gmail_user ?? "").trim();
  const to = String(config.email_to ?? "").trim();
  const pass = String(config.gmail_app_password ?? "").replace(/\s+/g, "");
  if (!user || !to || !pass) throw new Error("MAIL_CONFIG_MISSING");

  const smtp = new Smtp(await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 }));
  try {
    await smtp.expect(220);
    await smtp.command("EHLO trade-notification-mailer", 250);
    await smtp.command("AUTH LOGIN", 334);
    await smtp.command(btoa(user), 334);
    await smtp.command(btoa(pass), 235);
    await smtp.command(`MAIL FROM:<${user}>`, 250);
    await smtp.command(`RCPT TO:<${to}>`, 250, 251);
    await smtp.command("DATA", 354);

    const raw = [
      `From: =?UTF-8?B?${b64utf8("트레이딩 부우")}?= <${user}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      ...(b64utf8(body).match(/.{1,76}/g) ?? []),
    ].join("\r\n");

    const accepted = await smtp.message(raw);
    try { await smtp.command("QUIT", 221); } catch { /* already accepted */ }
    return accepted;
  } finally {
    smtp.close();
  }
}

function entryMemo(d: any) {
  const parts: string[] = [];
  if (d?.pattern) parts.push(String(d.pattern));
  const rank = num(d?.gainer_rank, -1);
  if (rank > 0) parts.push(`24H 상승률 TOP10 중 ${Math.round(rank)}위`);
  const pre = bool(d?.m1_pre_breakout), core = bool(d?.m1_core_passed);
  if (pre && core) parts.push("M1 사전돌파·코어 조건 통과");
  else if (pre) parts.push("M1 사전돌파 조건 통과");
  else if (core) parts.push("M1 코어 조건 통과");
  if (d?.trade_pressure_fast != null) parts.push(`매수압력 ${num(d.trade_pressure_fast).toFixed(3)}`);
  if (d?.data_quality != null) {
    const q = num(d.data_quality);
    parts.push(`데이터품질 ${(q <= 1.5 ? q * 100 : q).toFixed(1)}%`);
  }
  if (d?.spread_bps != null) parts.push(`스프레드 ${num(d.spread_bps).toFixed(2)}bp`);
  return `진입 메모: ${parts.length ? parts.join(" · ") : "-"}`;
}

function compose(p: any) {
  const n = p.outbox ?? {}, f = p.fill ?? {};
  const market = String(n.market ?? "UNKNOWN"), exchange = String(n.exchange ?? "-").toUpperCase();
  const quote = String(f.quote_asset ?? ""), base = String(f.base_asset ?? "");
  const at = f.last_executed_at ?? n.last_fill_at;
  const common = [`거래소: ${exchange}`, `체결시각: ${kst(at)}`];

  if (n.event_type === "BUY") {
    return {
      subject: `🟢 [트레이딩 부우] BUY ${market} · ${money(f.quote_amount)} ${quote}`,
      body: [
        "자동매매 매수 체결", "", ...common,
        `평균 매수가: ${compact(f.average_price)} ${quote}`,
        `체결수량: ${compact(f.quantity)} ${base}`,
        `체결금액: ${money(f.quote_amount)} ${quote}`,
        `수수료: ${num(f.fee_quote_amount).toFixed(4)} ${quote}`,
        `체결 조각: ${Math.max(1, Math.round(num(f.count, 1)))}건`, "", entryMemo(p.decision),
      ].join("\n"),
    };
  }

  const pnl = num(f.realized_pnl_quote), cost = num(f.realized_cost_quote);
  const pct = cost ? 100 * pnl / cost : 0;
  const closed = n.event_type === "SELL_CLOSE", label = closed ? "전량청산" : "부분청산";
  const emoji = closed && pnl < 0 ? "🔴" : "🔵";
  const lines = [
    `자동매매 ${label}`, "", ...common,
    `평균 매도가: ${compact(f.average_price)} ${quote}`,
    `매도수량: ${compact(f.quantity)} ${base}`,
    `체결금액: ${money(f.quote_amount)} ${quote}`,
    `수수료: ${num(f.fee_quote_amount).toFixed(4)} ${quote}`,
    `확정손익: ${signedMoney(pnl)} ${quote}`,
    `확정수익률: ${signedPct(pct)}`,
    `청산 사유: ${p.order?.purpose || p.position?.close_reason || "-"}`,
    `잔여수량: ${compact(f.inventory_quantity_after ?? 0)} ${base}`,
    `체결 조각: ${Math.max(1, Math.round(num(f.count, 1)))}건`,
  ];
  if (closed && p.position?.realized_pnl_quote != null) {
    lines.push(`포지션 누적손익: ${signedMoney(p.position.realized_pnl_quote)} ${quote}`);
  }
  if (closed && p.position?.realized_return_pct != null) {
    lines.push(`포지션 누적수익률: ${signedPct(p.position.realized_return_pct)}`);
  }
  return { subject: `${emoji} [트레이딩 부우] SELL ${market} · ${signedPct(pct)} ${label}`, body: lines.join("\n") };
}

async function failed(id: number, error: unknown) {
  try {
    await rpc("mark_trade_notification_failed", {
      p_outbox_id: id,
      p_error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
  } catch (e) {
    console.error("notification failure audit failed", e instanceof Error ? e.message : String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });
  const token = req.headers.get("x-trade-notification-token") ?? "";
  if (!token) return response(401, { error: "UNAUTHORIZED" });

  try {
    if (await rpc<boolean>("verify_trade_notification_dispatch_token", { p_token: token }) !== true) {
      return response(401, { error: "UNAUTHORIZED" });
    }
    const body = await req.json().catch(() => ({})) as Json;
    const config = await rpc<any>("get_trade_notification_mail_config");
    if (!config?.gmail_user || !config?.gmail_app_password || !config?.email_to) {
      return response(503, { error: "MAIL_CONFIG_MISSING" });
    }

    if (body.test === true) {
      await sendGmail(config, "✅ [트레이딩 부우] 실시간 체결 알림 테스트",
        `Supabase 실시간 체결 알림 발송 경로가 정상입니다.\n\n확인시각: ${kst(new Date().toISOString())}`);
      return response(200, { ok: true, status: "test_sent" });
    }

    const id = Number(body.outbox_id);
    if (!Number.isSafeInteger(id) || id <= 0) return response(400, { error: "INVALID_OUTBOX_ID" });
    await sleep(750);

    const payload = await rpc<any>("get_trade_notification_email_payload", { p_outbox_id: id });
    if (!payload?.outbox) { await failed(id, "OUTBOX_PAYLOAD_NOT_FOUND"); return response(404, { error: "OUTBOX_PAYLOAD_NOT_FOUND" }); }
    if (payload.outbox.sent_at) return response(200, { ok: true, status: "already_sent" });
    if (num(payload.fill?.count) <= 0) { await failed(id, "ACCOUNTED_FILL_NOT_FOUND"); return response(409, { error: "ACCOUNTED_FILL_NOT_FOUND" }); }

    const mail = compose(payload);
    try { await sendGmail(config, mail.subject, mail.body); }
    catch (e) { await failed(id, e); throw e; }

    await rpc("mark_trade_notification_sent", { p_outbox_id: id });
    return response(200, { ok: true, status: "sent", outbox_id: id });
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    console.error("trade notification mailer failed", detail);
    return response(500, { error: "SEND_FAILED", detail });
  }
});
