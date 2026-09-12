import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The dashboard banner read "v5.2.3" while the engine was on 5.7.x.
 *
 * The banner is populated from ENGINE_VERSION in market-scanner/engine.ts, which had not
 * been touched since v5.2.3 — every release since then bumped market-autotrader and the
 * gateway but not the scanner. Nothing failed, so nothing surfaced it; the operator simply
 * had no way to tell which build was actually running, which matters a great deal when a
 * deploy fails halfway and the functions do not get replaced.
 *
 * Three constants must agree. This test is the only thing that will notice when they stop.
 */

const ROOT = new URL("../../../../", import.meta.url);

async function versionIn(path: string, pattern: RegExp): Promise<string> {
  const text = await Deno.readTextFile(new URL(path, ROOT));
  const match = text.match(pattern);
  if (!match) throw new Error(`no version constant found in ${path}`);
  return match[1];
}

Deno.test("engine, autotrader and gateway report the same version", async () => {
  const [scanner, autotrader, gateway] = await Promise.all([
    versionIn(
      "supabase/functions/market-scanner/engine.ts",
      /export const ENGINE_VERSION = "([^"]+)"/,
    ),
    versionIn("supabase/functions/market-autotrader/index.ts", /const VERSION = "([^"]+)"/),
    versionIn("gateway/server.mjs", /const VERSION = "([^"]+)"/),
  ]);
  assertEquals(
    { autotrader, gateway },
    { autotrader: scanner, gateway: scanner },
    `version drift — scanner ${scanner}, autotrader ${autotrader}, gateway ${gateway}`,
  );
});

Deno.test("the dashboard fallback banner is not older than the engine", async () => {
  const scanner = await versionIn(
    "supabase/functions/market-scanner/engine.ts",
    /export const ENGINE_VERSION = "([^"]+)"/,
  );
  const html = await Deno.readTextFile(new URL("docs/index.html", ROOT));
  const banner = html.match(/SPOT · v([0-9A-Za-z.-]+)/);
  // The banner is overwritten from the API once a scan loads, but until then this string
  // is what the operator sees — and after a failed deploy it may be all they ever see.
  assertEquals(banner?.[1], scanner, "docs/index.html banner version is stale");
});

Deno.test("operator status is the authoritative dashboard version source", async () => {
  const app = await Deno.readTextFile(new URL("docs/app.js", ROOT));
  const html = await Deno.readTextFile(new URL("docs/index.html", ROOT));
  assertEquals(
    app.includes("window.updateTradingBrandVersion(data?.version, true)"),
    true,
    "trading status must update the header from the deployed autotrader",
  );
  assertEquals(
    app.includes("window.updateTradingBrandVersion ="),
    true,
    "the shared version updater must be available to both dashboard modules",
  );
  assertEquals(
    app.includes("authoritativeEngineVersion || reported || configured"),
    true,
    "a cached scanner result must not downgrade the authoritative version",
  );
  const config = await Deno.readTextFile(new URL("docs/config.js", ROOT));
  const revision = config.match(/const DASHBOARD_REVISION = "([^"]+)"/)?.[1];
  assertEquals(
    typeof revision === "string" && revision.length > 0,
    true,
    "docs/config.js must declare a dashboard revision",
  );
  // The cache key is derived from the declared revision rather than pinned to a literal,
  // so a dashboard release only has to bump one constant — and the tripwire still fires
  // when the HTML is left behind on the previous key.
  assertEquals(
    html.includes(`config.js?v=${revision}`) && html.includes(`app.js?v=${revision}`),
    true,
    "dashboard cache keys must move with the dashboard release",
  );
});
