import { writeFileSync } from "node:fs";
import { findTrigger, loadFixtures, mergeCandidates } from "./replay.mjs";
import { SETUP_POLICY, SETUP_STATE } from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";

const pullback = Number(process.argv[2] ?? 0.0025);
const policy = { ...SETUP_POLICY, minPullbackPct: pullback };
const { candidates, setupBars } = loadFixtures();
const { kept, merged } = mergeCandidates(candidates, policy);

const outcomes = {}, triggers = [];
let noBars = 0;
for (const c of kept) {
  const bars = setupBars[c.id];
  if (!bars || bars.length < 3) { noBars++; outcomes.NO_BARS = (outcomes.NO_BARS ?? 0) + 1; continue; }
  const { state } = findTrigger(c, bars, policy);
  const s = state?.state ?? "NONE";
  outcomes[s] = (outcomes[s] ?? 0) + 1;
  if (s === SETUP_STATE.TRIGGERED) {
    triggers.push({ id: c.id, symbol: c.symbol, s5c: c.s5c, ref: c.ref,
      triggerAt: state.triggerAt, triggerClose: state.triggerClose,
      pullbackLow: state.pullbackLow, dayReturn: c.dayReturn, volumeRatio: c.volumeRatio });
  }
}
console.log(`pullback=${(pullback*100).toFixed(2)}%  candidates=${candidates.length} ` +
  `merged_away=${merged.length} evaluated=${kept.length} no_bars=${noBars}`);
console.log(JSON.stringify(outcomes, null, 0));
console.log(`TRIGGERS: ${triggers.length}`);
if (process.argv[3] === "--write") {
  writeFileSync(new URL("data/triggers.json", import.meta.url), JSON.stringify(triggers));
  console.log("wrote data/triggers.json");
}
