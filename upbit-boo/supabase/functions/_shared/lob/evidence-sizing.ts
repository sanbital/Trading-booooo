// Trading-booooo v6.10.0 — hierarchical, age-aware evidence sizing.
//
// A new market may borrow strength from its exchange-pattern parent, but parent evidence is
// capped and cannot unlock a full slot by itself. Evidence also decays with age so a large,
// stale sample cannot command full capital after a regime change.

import type { LobAdaptivePolicyDefinition } from "./adaptive-policy.ts";

export interface LobEvidenceSizingInput {
  dataQuality: number;
  dynamicStatus: string;
  featureSamples: number;
  marketSamples: number;
  patternSamples: number;
  marketUpdatedAtMs?: number | null;
  patternUpdatedAtMs?: number | null;
  nowMs?: number;
}
export interface LobEvidenceSizingDecision {
  fraction: number;
  qualityScore: number;
  featureScore: number;
  marketScore: number;
  parentScore: number;
  onlineScore: number;
  marketRecencyWeight: number;
  parentRecencyWeight: number;
  lowEvidence: boolean;
  cappedBy: "NONE" | "INSUFFICIENT_STATUS" | "LOW_DATA_QUALITY" | "STALE_EVIDENCE";
  reason: string;
}
function finite(value: unknown, fallback = 0): number { const n=Number(value); return Number.isFinite(n)?n:fallback; }
function clamp(value:number,low:number,high:number){return Math.max(low,Math.min(high,Number.isFinite(value)?value:low));}
function recencyWeight(updatedAtMs: number | null | undefined, nowMs: number, halfLifeHours: number): number {
  const updated=finite(updatedAtMs, nowMs);
  const ageHours=Math.max(0,(nowMs-updated)/3_600_000);
  return Math.pow(0.5, ageHours/Math.max(1,halfLifeHours));
}
export function lobEvidenceSizeFraction(input:LobEvidenceSizingInput,policy:LobAdaptivePolicyDefinition):LobEvidenceSizingDecision{
  const cfg=policy.evidenceSizing;
  const floor=clamp(cfg.unprovenFloorFraction,0.10,0.60);
  const nowMs=finite(input.nowMs,Date.now());
  const qualityScore=clamp(finite(input.dataQuality)/cfg.dataQualityForFullSize,0,1);
  const featureScore=clamp(finite(input.featureSamples)/cfg.featureSamplesForFullSize,0,1);
  const marketRecencyWeight=recencyWeight(input.marketUpdatedAtMs,nowMs,cfg.evidenceHalfLifeHours);
  const parentRecencyWeight=recencyWeight(input.patternUpdatedAtMs,nowMs,cfg.evidenceHalfLifeHours);
  const marketScore=clamp(finite(input.marketSamples)/cfg.marketSamplesForFullSize,0,1)*marketRecencyWeight;
  const parentScore=clamp(finite(input.patternSamples)/cfg.patternSamplesForFullSize,0,1)*parentRecencyWeight;
  // Hierarchical shrinkage: exact-market evidence gradually replaces the parent. A parent
  // can carry an unseen market only to parentEvidenceCap and never to 100% sizing.
  const marketWeight=clamp(finite(input.marketSamples)/(finite(input.marketSamples)+24),0,1);
  const borrowed=Math.min(cfg.parentEvidenceCap,parentScore)*(1-marketWeight);
  const onlineScore=clamp(marketScore*marketWeight+borrowed,0,1);
  const evidence=Math.cbrt(Math.max(0,qualityScore*featureScore*onlineScore));
  const independentlyMature = qualityScore >= 1 && featureScore >= 1 && marketScore >= 0.999 &&
    parentScore >= 0.999 && marketRecencyWeight >= 0.75 && parentRecencyWeight >= 0.75;
  // Bayesian shrinkage approaches one asymptotically. Once every reviewed threshold is
  // independently satisfied, promote sizing to exactly one slot instead of leaving a
  // permanently low-evidence 0.99 fraction because of the mathematical prior.
  let fraction=independentlyMature ? 1 : clamp(floor+(1-floor)*evidence,floor,1);
  let cappedBy:LobEvidenceSizingDecision['cappedBy']='NONE';
  const status=String(input.dynamicStatus||'').toUpperCase();
  if(status.includes('INSUFFICIENT')){fraction=Math.min(fraction,cfg.insufficientStatusCap);cappedBy='INSUFFICIENT_STATUS';}
  if(finite(input.dataQuality)<0.25){fraction=Math.min(fraction,cfg.lowQualityCap);cappedBy='LOW_DATA_QUALITY';}
  if(Math.max(marketRecencyWeight,parentRecencyWeight)<0.25){fraction=Math.min(fraction,cfg.insufficientStatusCap);cappedBy='STALE_EVIDENCE';}
  fraction=clamp(fraction,floor,1);
  const lowEvidence=fraction<0.999 || cappedBy!=='NONE';
  return {fraction,qualityScore,featureScore,marketScore,parentScore,onlineScore,marketRecencyWeight,parentRecencyWeight,lowEvidence,cappedBy,reason:cappedBy==='NONE'?`hierarchical evidence ${(evidence*100).toFixed(0)}%`:`${cappedBy.toLowerCase()}: hierarchical evidence ${(evidence*100).toFixed(0)}%`};
}
