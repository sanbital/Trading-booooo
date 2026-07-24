// Fetch the fixed cross-market calibration basket. Fixed membership makes each
// scheduled run comparable; edit markets.json intentionally when the universe changes.

import { fetchMarketHistory } from "./fetch-history.ts";

if (import.meta.main) {
  const days = Number(Deno.args[0] || 180);
  const configPath = Deno.args[1] || "backtest/markets.json";
  const config = JSON.parse(await Deno.readTextFile(configPath)) as {
    upbit: string[];
    binance: string[];
  };
  await Deno.remove("backtest/data", { recursive: true }).catch(() => {});
  await Deno.mkdir("backtest/data", { recursive: true });
  const failures: string[] = [];
  const success = { upbit: 0, binance: 0 };
  for (const exchange of ["upbit", "binance"] as const) {
    for (const market of config[exchange] || []) {
      try {
        console.error(`[${exchange}] ${market} ${days}일 수집`);
        const history = await fetchMarketHistory(exchange, market, days);
        const path = `backtest/data/${exchange}-${market}.json`;
        await Deno.writeTextFile(path, JSON.stringify(history));
        success[exchange]++;
        console.error(`저장 ${path} · m15 ${history.m15.length} / day ${history.day.length}`);
      } catch (error) {
        failures.push(`${exchange}:${market}:${String(error)}`);
        console.error(`실패 ${exchange} ${market}: ${String(error)}`);
      }
    }
  }
  if (failures.length) {
    await Deno.writeTextFile("backtest/data/fetch-failures.txt", failures.join("\n"));
  }
  const files: string[] = [];
  for await (const entry of Deno.readDir("backtest/data")) {
    if (entry.isFile && entry.name.endsWith(".json")) files.push(entry.name);
  }
  if (files.length < 6 || success.upbit < 2 || success.binance < 2) {
    console.error(
      `수집 성공 ${files.length}개(업비트 ${success.upbit}, 바이낸스 ${success.binance})라 자동 교정을 중단합니다.`,
    );
    Deno.exit(1);
  }
  console.error(`수집 완료: ${files.length}개 시장 · 업비트 ${success.upbit} / 바이낸스 ${success.binance}`);
}
