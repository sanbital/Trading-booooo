// v6.10 residual inventory rules. Dust is an account asset, not a trading loss.
export interface ResidualSweepDecisionInput {
  quantity: number;
  markPrice: number;
  minOrderQuote: number;
  activePosition: boolean;
  openOrder: boolean;
  plannedReentry: boolean;
  sweepBuffer?: number;
}
export interface ResidualSweepDecision { allowed: boolean; valueQuote: number; reason: string; }
function finite(value: unknown, fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback;}
export function residualSweepDecision(input: ResidualSweepDecisionInput): ResidualSweepDecision {
  const valueQuote=Math.max(0,finite(input.quantity))*Math.max(0,finite(input.markPrice));
  if(input.activePosition) return {allowed:false,valueQuote,reason:"ACTIVE_POSITION"};
  if(input.openOrder) return {allowed:false,valueQuote,reason:"OPEN_ORDER"};
  if(input.plannedReentry) return {allowed:false,valueQuote,reason:"PLANNED_REENTRY"};
  const threshold=Math.max(0,finite(input.minOrderQuote))*Math.max(1,finite(input.sweepBuffer,1.10));
  if(valueQuote<threshold) return {allowed:false,valueQuote,reason:"BELOW_SWEEP_THRESHOLD"};
  return {allowed:true,valueQuote,reason:"SWEEP_READY"};
}
