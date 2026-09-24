// VM tests strip imports from the real manager. Keep their module boundary current.
import * as cec from '../supabase/functions/_shared/leader-cec0040.mjs';
import * as fd1 from '../supabase/functions/v10-lane-executor/gpt-final-decision-adapter.mjs';
export const managerBindings={...cec,...fd1,FD1_TIME_REASONS:fd1.TIME_REASONS};
