import assert from "node:assert/strict";
import { POLICY, entryReason } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";

const base={
  symbol:"TESTUSDT",rank:1,dayReturn:.05,return15m:.002,
  return30m:.01,return60m:.02,volumeRatio:1.5,qv24:10_000_000,
  atr:.01,signal15Close:1,
};

assert.equal(POLICY.maxDayReturn,.08);
assert.equal(POLICY.minVolumeRatio,1.30);
assert.equal(entryReason(base),"ELIGIBLE");
assert.equal(entryReason({...base,dayReturn:.079999}),"ELIGIBLE");
assert.equal(entryReason({...base,dayReturn:.08}),"DAY_RETURN_CHASE_CAP");
assert.equal(entryReason({...base,dayReturn:.20}),"DAY_RETURN_CHASE_CAP");
assert.equal(entryReason({...base,volumeRatio:1.299999}),"VOLUME_ACCELERATION");
assert.equal(entryReason({...base,volumeRatio:1.30}),"ELIGIBLE");

console.log("v17 parity gate ok");
