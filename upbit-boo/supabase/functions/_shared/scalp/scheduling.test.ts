import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Deploy guard for the 2026-07-27 finding.
 *
 * v5.9 cut the calibration interval from 6 hours to 1 hour and lowered the Platt minimum
 * sample count to 60. `scalp-calibration` was added to the deploy list — and nothing ever
 * called it. There was no schedule, no manual trigger, and no internal caller. Every
 * report since then described an interval that existed only on paper, and the pWin model
 * kept running on its prior no matter how many samples accumulated.
 *
 * Nothing failed, which is exactly why it survived: an endpoint that is never invoked
 * returns no errors.
 *
 * A function that is deployed must be reachable by something. This test is the only thing
 * that will notice when it is not.
 */

const ROOT = new URL("../../../../", import.meta.url);
const WORKFLOWS = new URL(".github/workflows/", ROOT);
const FUNCTIONS = new URL("supabase/functions/", ROOT);

async function readAll(dir: URL, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(suffix)) {
      out.push(await Deno.readTextFile(new URL(entry.name, dir)));
    }
  }
  return out;
}

/** Function names listed in the deploy loop of the Supabase workflow. */
async function deployedFunctions(): Promise<string[]> {
  const sql = await Deno.readTextFile(new URL("main.deploy-supabase.yml", WORKFLOWS));
  const match = sql.match(/for fn in ([a-z0-9 \-]+);/);
  if (!match) throw new Error("deploy loop not found in main.deploy-supabase.yml");
  return match[1].trim().split(/\s+/);
}

Deno.test("every deployed function has something that calls it", async () => {
  const deployed = await deployedFunctions();
  const workflows = (await readAll(WORKFLOWS, ".yml")).join("\n");

  // Internal callers: one function invoking another over the functions/v1 path.
  const sources: string[] = [];
  for await (const entry of Deno.readDir(FUNCTIONS)) {
    if (!entry.isDirectory) continue;
    const dir = new URL(`${entry.name}/`, FUNCTIONS);
    for await (const file of Deno.readDir(dir)) {
      if (file.isFile && file.name.endsWith(".ts")) {
        sources.push(await Deno.readTextFile(new URL(file.name, dir)));
      }
    }
  }
  const code = sources.join("\n");

  const orphans = deployed.filter((fn) => {
    const invokedByWorkflow = workflows.includes(`functions/v1/${fn}`);
    const invokedByCode = code.includes(`functions/v1/${fn}`);
    return !invokedByWorkflow && !invokedByCode;
  });

  assertEquals(
    orphans,
    [],
    `deployed but never invoked — no schedule, no trigger, no caller: ${orphans.join(", ")}`,
  );
});

Deno.test("the two calibration schedules do not collide", async () => {
  const scalp = await Deno.readTextFile(new URL("scalp-calibration.yml", WORKFLOWS));
  const lob = await Deno.readTextFile(new URL("lob-calibration.yml", WORKFLOWS));
  const minuteOf = (text: string): string => {
    const match = text.match(/cron:\s*"(\d+)\s/);
    if (!match) throw new Error("no cron minute found");
    return match[1];
  };
  // Both read the same closed-position window. Running them in the same minute makes the
  // sample each one sees depend on which finished first.
  const collided = minuteOf(scalp) === minuteOf(lob);
  assertEquals(collided, false, "scalp and LOB calibration run in the same minute");
});
