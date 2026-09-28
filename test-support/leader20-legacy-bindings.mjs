export * from '../supabase/functions/_shared/leader20/campaign.mjs';
export {entryQueueWithLateReviews} from '../supabase/functions/v10-lane-executor/entry-late-review.mjs';
import {isLeader20} from '../supabase/functions/_shared/leader20/campaign.mjs';
export const leaderControl=async()=>({active_strategy:'LEGACY',observation_enabled:false});
export async function requireEntryAuthority(_db,row){if(isLeader20(row))throw Error('Use real Leader20 DB authority in new-strategy tests');}

export const leader20Control={active_strategy:'LEGACY',observation_enabled:false};
