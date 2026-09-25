/** LE score V2 (record only; never used to select, admit or reject).
 * Lane rule + directional band points whose SIGNS come from the pre-registered audit findings
 * (research/leader-emerging-shadow-20260924/README.md §5), not fitted weights, plus explicit costs.
 *   robust (-): rank 4-10 (excess 1h t -3.17); Top10 & vr15 >= 4 (first entry 1h -0.415%, t -2.96)
 *   weak (+):   EMERGING 11-20 with rank velocity (1h +0.15~0.25%, t 1.7~2.2, gone at 2h)
 *   weak (-):   day >= 20% at entry (live trades), 15m rank fading
 * edge_prior_bps is the audit's pre-cost 1h estimate for the lane; edge_after_cost_bps subtracts
 * the measured round-trip cost of THIS candidate. */
export const SCORE_V2_VERSION='LE_SCORE_V2_1';
const fin=x=>typeof x==='number'&&Number.isFinite(x);

export function scoreV2({lane,rank,velocity15,velocity60,vr15,dayReturn,firstTop10Today,cost}){
  const parts=[];
  const add=(k,pts,why)=>parts.push({k,pts,why});
  if(lane==='EMERGING'&&rank>=11&&rank<=20)add('lane',+1,'EMERGING 11-20 (weak +)');
  else if(lane==='EMERGING'&&rank>=21)add('lane',+.5,'EMERGING 21-30 (diluted)');
  else if(rank>=4&&rank<=10)add('lane',-1,'rank 4-10 (robust -)');
  else if(lane==='LEADER')add('lane',0,'LEADER first entry (first-entry 1h negative, not significant)');
  if(rank<=10&&fin(vr15)&&vr15>=4)add('volume',-2,'Top10 & vr15>=4 (robust -)');
  else if(rank>=11&&fin(vr15)&&vr15>=2&&vr15<4)add('volume',+.5,'11-30 & vr15 2-4');
  if(fin(dayReturn)&&dayReturn>=.20)add('extension',-1,'day >= 20%');
  if(fin(velocity15)&&velocity15<=-5)add('rank_fading',-1,'15m rank -5 or worse');
  if(firstTop10Today&&rank<=10)add('first_top10',0,'first Top10 today (recorded, no sign)');
  const edgePrior=lane==='EMERGING'&&rank>=11&&rank<=20?20:lane==='EMERGING'?8:rank<=3?0:-12;
  const costBps=fin(cost?.roundtrip_cost_bps_real)?cost.roundtrip_cost_bps_real:null;
  return {version:SCORE_V2_VERSION,semantics:'RECORD_ONLY',points:parts.reduce((s,p)=>s+p.pts,0),parts,
    velocity:{v15:fin(velocity15)?velocity15:null,v60:fin(velocity60)?velocity60:null},
    edge_prior_bps:edgePrior,roundtrip_cost_bps_real:costBps,
    edge_after_cost_bps:costBps===null?null:edgePrior-costBps,stress_cost_bps:44};
}
