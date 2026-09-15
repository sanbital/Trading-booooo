import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { residualSweepDecision } from "./residual-ledger.ts";
Deno.test("residual never sweeps against an active position",()=>{
  assertEquals(residualSweepDecision({quantity:2,markPrice:100,minOrderQuote:100,activePosition:true,openOrder:false,plannedReentry:false}).reason,"ACTIVE_POSITION");
});
Deno.test("residual sweeps only above buffered minimum with no conflicts",()=>{
  assertEquals(residualSweepDecision({quantity:1.2,markPrice:100,minOrderQuote:100,activePosition:false,openOrder:false,plannedReentry:false}).allowed,true);
});
