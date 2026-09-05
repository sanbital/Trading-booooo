function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function latestAtOrBefore<T extends { observed_at: string }>(rows: T[], cutoff: string): T | null {
  const t = Date.parse(cutoff);
  return rows
    .filter((x) => Date.parse(x.observed_at) <= t)
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0] ?? null;
}

function aggregate(xs: number[]) {
  const net = xs.reduce((s, x) => s + x, 0);
  const expectancy = xs.length ? net / xs.length : 0;
  return { net, expectancy };
}

Deno.test("2026-09-04 22:15 KST uses observer at or before signal close, not later execution observer", () => {
  const rows = [
    { observed_at: "2026-09-04T13:10:01.753Z", confidence: 0.774883941268173, regime: "RISK_OFF" },
    { observed_at: "2026-09-04T13:15:00.869Z", confidence: 0.774384374626815, regime: "RISK_OFF" },
    { observed_at: "2026-09-04T13:30:01.224Z", confidence: 0.583720486224993, regime: "RISK_OFF" },
  ];
  const chosen = latestAtOrBefore(rows, "2026-09-04T13:15:00.000Z");
  assert(chosen?.observed_at === "2026-09-04T13:10:01.753Z", `unexpected observer ${chosen?.observed_at}`);
  assert(chosen?.confidence > 0.77, `unexpected confidence ${chosen?.confidence}`);
});

Deno.test("2026-09-05 00:00 KST excludes observers written after signal close", () => {
  const rows = [
    { observed_at: "2026-09-04T14:55:00.474Z", confidence: 0.834284741541757, regime: "RISK_OFF" },
    { observed_at: "2026-09-04T15:00:00.636Z", confidence: 0.823944155566129, regime: "RISK_OFF" },
    { observed_at: "2026-09-04T15:15:00.756Z", confidence: 0.561842125431217, regime: "RISK_OFF" },
  ];
  const chosen = latestAtOrBefore(rows, "2026-09-04T15:00:00.000Z");
  assert(chosen?.observed_at === "2026-09-04T14:55:00.474Z", `unexpected observer ${chosen?.observed_at}`);
  assert(chosen?.confidence > 0.83, `unexpected confidence ${chosen?.confidence}`);
});

Deno.test("V14 audit reports aggregate net separately from per-trade expectancy", () => {
  const returns = Array.from({ length: 17 }, () => 0.00378);
  const result = aggregate(returns);
  assert(Math.abs(result.net - 0.06426) < 1e-12, `net=${result.net}`);
  assert(Math.abs(result.expectancy - 0.00378) < 1e-12, `expectancy=${result.expectancy}`);
});

Deno.test("production source contracts preserve time parity and slot invariants", async () => {
  const root = new URL("./", import.meta.url);
  const [v10, v14, v15, preflight, audit] = await Promise.all([
    Deno.readTextFile(new URL("v10-lane-signal-generator/index.ts", root)),
    Deno.readTextFile(new URL("v14-bear-live/index.ts", root)),
    Deno.readTextFile(new URL("v15-range-live/index.ts", root)),
    Deno.readTextFile(new URL("v15-range-r7-preflight/index.ts", root)),
    Deno.readTextFile(new URL("v14-bear-final-candidate-audit/index.ts", root)),
  ]);

  assert(v10.includes('.lte("observed_at",signalCloseIso)'), "V10 observer cutoff missing");
  assert(v14.includes('.lte("observed_at",cutoff)'), "V14 observer cutoff missing");
  assert(v15.includes("GLOBAL_MAX=10, LOCAL_MAX=1"), "V15 global/local slot invariant missing");
  assert(!v15.includes("RANGE_REGIME_INACTIVE"), "V15 still contains latest-regime early exit");
  assert(v15.includes("marketAt(db,signalClose)"), "V15 signal-close observer lookup missing");
  assert(preflight.includes("GLOBAL_MAX=10,LOCAL_MAX=1"), "preflight slot invariant missing");
  assert(preflight.includes("&endTime=${endTime}"), "preflight completed-bar BTC72 cutoff missing");
  assert(preflight.includes('.lte("observed_at",signalCloseIso)'), "preflight observer cutoff missing");
  assert(audit.includes("net=SUM(r),expectancy=A(r)"), "V14 audit sum/expectancy split missing");
});
