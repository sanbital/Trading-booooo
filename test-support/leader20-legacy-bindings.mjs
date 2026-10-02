export * from '../supabase/functions/_shared/leader20/campaign.mjs';
export {entryQueueWithLateReviews} from '../supabase/functions/v10-lane-executor/entry-late-review.mjs';
import {isLeader20} from '../supabase/functions/_shared/leader20/campaign.mjs';
export const leaderControl=async()=>({active_strategy:'LEGACY',observation_enabled:false});
export async function requireEntryAuthority(_db,row){if(isLeader20(row))throw Error('Use real Leader20 DB authority in new-strategy tests');}

export const leader20Control={active_strategy:'LEGACY',observation_enabled:false};
// Bind the deployed module graph in historical VM integration harnesses too.
export * from '../supabase/functions/v10-lane-executor/execution-dispatch.mjs';
export * from '../supabase/functions/v10-lane-executor/entry-error-scope.mjs';
export * from '../supabase/functions/v10-lane-executor/cycle-runtime-outcome.mjs';

// Legacy tests extract individual host functions rather than the request router.
// Their original mode is disabled. Full-host VM definitions override these defaults.
export * from '../supabase/functions/v10-lane-executor/account-execution-context.mjs';
export {createHostAccountScopes} from '../supabase/functions/v10-lane-executor/account-host-scopes.mjs';
export const shortAccountWriter=()=>false;
export const withAccountMutation=async(_db,operation)=>operation();
