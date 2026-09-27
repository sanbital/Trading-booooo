import {DYNAMIC_VERSION, DYNAMIC_POLICY, HORIZONS, entryCaptureSafety} from './dynamic-flow.mjs';
const obj = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const prose = {type:'string',minLength:1,maxLength:280};
const citation = {type:'string',minLength:1,maxLength:160};
const citations = {type:'array',maxItems:8,items:citation};
export const DYNAMIC_EVIDENCE_FIELDS = Object.freeze(['return','velocity_bps_s','acceleration_bps_s2','net_taker_flow',
  'buy_share','flow_acceleration','bid_liquidity_change','ask_liquidity_change','imbalance','spread','trade_count',
  'high_renewal_slowdown','drawdown_from_sampled_peak','recovery_velocity_bps_s','arrival_rate_slope']);
export const DYNAMIC_PROMPT = `
STRUCTURAL STRENGTH and CURRENT PROPULSION are separate questions. Structural trend alone never justifies BUY or HOLD.
Read the ordered 5s, 15s, 30s, 60s, 120s horizons and price, flow, book, participation together.
dynamic_evidence and dynamic_risks contain ONLY exact numeric dot paths from their schema enum, never prose or values.
For these fields use paths relative to capture_context, such as dynamics.horizons.s30.net_taker_flow.
Put explanations in current_propulsion, structural_strength and uncertainty. If evidence is missing, use empty citation arrays.
WAIT is a normal decision: a strong symbol with uncertain timing should be observed again without adding exposure.
Explain current propulsion direction as ACCELERATING, STABLE, DECELERATING or REVERSING.
For each why_buy_now horizon, cite an exact numeric path under dynamics.horizons.s5/s15/s30/s60/s120.
why_buy_now.flow and .orderbook cite exact numeric paths relative to capture_context (e.g. dynamics.horizons.s30.net_taker_flow).
The reason must explain why entering now is preferable to waiting; never substitute a long-term trend for missing dynamic evidence.
If the full trajectory is unavailable, incomplete or stale, ENTRY/RECHECK must WAIT or SKIP. A fresh quote does not refresh a trajectory.
For an existing position, unavailable trajectory means DATA_DEGRADED, never an automatic HOLD or EXIT.
Keep the native hard stop and last approved protection. Consider emergency tape/book evidence, last valid capture age and price drift.
For ENTRY/RECHECK with advisor_valid=false, BUY requires confidence >= ${DYNAMIC_POLICY.singleModelBuyConfidence} and propulsion_direction ACCELERATING or STABLE.
Report confidence honestly; do not inflate it to pass this rule. Otherwise WAIT or SKIP.
Advisor validity and dual confidence status are server-owned; never generate them.
Use multi-axis weakness for entry failure and loss of thesis. A single negative bucket or normal winner pullback does not require EXIT.
Time elapsed may schedule a review but never supplies an exit reason. Protection can only rise.
For same-symbol re-entry, use history.new_high_since_prev_exit, price_vs_prev_peak and price_vs_prev_exit together with NEW acceleration,
volume impulse, buyer participation and OI expansion. Missing history remains unknown. A previous win or higher price alone is not a reason to BUY.
Use one short clause per prose field, at most twelve words. Cite one path per horizon and at most three paths in other arrays. Return conclusions, not chain-of-thought. Numeric citations are checked against the frozen capture.`;
export function dynamicWireProperties(task) {
  const common = {structural_strength:prose,current_propulsion:prose,
    propulsion_direction:{type:'string',enum:['ACCELERATING','STABLE','DECELERATING','REVERSING']},
    dynamic_evidence:citations,dynamic_risks:citations};
  if (task === 'HOLD') return {...common,uncertainty:prose,
    confidence:{type:'number'},dynamic_action:{type:'string',enum:['HOLD','HOLD_AND_RAISE_PROTECTION','HOLD_WITH_TIGHTER_RISK',
      'EXIT_THESIS_BROKEN','EXIT_SELL_DOMINANCE','EXIT_MOMENTUM_FAILURE','EXIT_PROFIT_PROTECTION']}};
  return {...common,why_buy_now:obj({summary:prose,
    horizons:obj(Object.fromEntries(HORIZONS.map(s=>['s'+s,obj({summary:prose,evidence:citations})]))),
    flow:citations,orderbook:citations}),why_not_wait:prose,
    ...(task==='RECHECK'?{confidence:{type:'number'},invalidation:prose}:{})};
}
export const dynamicEnabled = packet => packet?.dynamic_policy === DYNAMIC_VERSION;
export function extendDynamicSchema(schema, task, packet) {
  if (!dynamicEnabled(packet)) return schema;
  const extra=dynamicWireProperties(task);
  const capture=packet.facts?.capture_context;
  const keys=HORIZONS.flatMap(s=>DYNAMIC_EVIDENCE_FIELDS.map(k=>'dynamics.horizons.s'+s+'.'+k))
    .filter(k=>valueAt(capture,k)!==null);
  const menu=paths=>paths.length?{...citations,items:{type:'string',enum:paths}}:{...citations,maxItems:0};
  extra.dynamic_evidence=menu(keys);extra.dynamic_risks=menu(keys);
  if(extra.why_buy_now){
    for(const s of HORIZONS)extra.why_buy_now.properties.horizons.properties['s'+s].properties.evidence=menu(keys.filter(k=>k.startsWith('dynamics.horizons.s'+s+'.')));
    extra.why_buy_now.properties.flow=menu(keys.filter(k=>/\.(net_taker_flow|buy_share|flow_acceleration)$/.test(k)));
    extra.why_buy_now.properties.orderbook=menu(keys.filter(k=>/\.(bid_liquidity_change|ask_liquidity_change|imbalance|spread)$/.test(k)));
  }
  return {...schema,properties:{...schema.properties,...extra},required:[...schema.required,...Object.keys(extra)]};
}
function valueAt(c,path) {
  if(typeof path!=='string'||!/^dynamics\.(horizons\.s(?:5|15|30|60|120)\.[a-z_0-9]+|[a-z_0-9]+)$/.test(path))return null;
  const value=path.split('.').reduce((v,k)=>v?.[k],c);
  return Number.isFinite(value)?value:null;
}
function require(ok,reason){if(!ok)throw Error('FD_DYNAMIC_'+reason);}
export function validateDynamicWire(wire,packet) {
  if (!dynamicEnabled(packet)) return null;
  const capture=packet.facts?.capture_context, decision=wire.d;
  const paths=[...(wire.dynamic_evidence??[]),...(wire.dynamic_risks??[])];
  if(packet.task!=='HOLD') paths.push(...(wire.why_buy_now?.flow??[]),...(wire.why_buy_now?.orderbook??[]),
    ...HORIZONS.flatMap(s=>wire.why_buy_now?.horizons?.['s'+s]?.evidence??[]));
  for(const path of paths)require(valueAt(capture,path)!==null,'CITED_EVIDENCE_MISSING');
  if(decision==='BUY') {
    const at=packet.dynamic_as_of_ms;
    require(entryCaptureSafety(capture,at).ok,'BUY_WITHOUT_VALID_TRAJECTORY');
    require(wire.dynamic_evidence.length>0,'BUY_WITHOUT_EVIDENCE');
    for(const s of HORIZONS) require(wire.why_buy_now.horizons['s'+s].evidence.some(p=>p.startsWith('dynamics.horizons.s'+s+'.')),'BUY_HORIZON_MISSING');
    require(wire.why_buy_now.flow.some(p=>/\.(net_taker_flow|buy_share|flow_acceleration|aggressive_buy|aggressive_sell|buy_share_slope)$/.test(p)),'BUY_FLOW_MISSING');
    require(wire.why_buy_now.orderbook.some(p=>/\.(bid_liquidity_change|ask_liquidity_change|imbalance|bid_depth|ask_depth|spread|buy_impact_450_bps)$/.test(p)),'BUY_BOOK_MISSING');
  }
  require(Number.isFinite(wire.confidence)&&wire.confidence>=0&&wire.confidence<=1,'CONFIDENCE_INVALID');
  if(packet.task==='HOLD'){
    const compatible=decision==='HOLD'?['HOLD','HOLD_WITH_TIGHTER_RISK']:decision==='PROTECT'?['HOLD_AND_RAISE_PROTECTION','HOLD_WITH_TIGHTER_RISK']:
      decision==='EXIT'?['EXIT_THESIS_BROKEN','EXIT_SELL_DOMINANCE','EXIT_MOMENTUM_FAILURE','EXIT_PROFIT_PROTECTION']:null;
    require(!compatible||compatible.includes(wire.dynamic_action),'ACTION_MISMATCH');
    if(capture?.status==='AVAILABLE'&&decision!=='ABSTAIN')require(paths.length>0,'POSITION_EVIDENCE_REQUIRED');
  }
  return Object.fromEntries(Object.keys(dynamicWireProperties(packet.task)).map(k=>[k,wire[k]]));
}

/** Shorter live output only; historical wire validation retains its original limits. */
export function boundedDynamicTransportSchema(schema){
  const result=structuredClone(schema),p=result.properties;
  const short=x=>{if(x?.type==='string'&&!x.enum)x.maxLength=Math.min(x.maxLength??120,120);};
  const few=(x,max=3)=>{if(x?.type==='array')x.maxItems=Math.min(x.maxItems??max,max);};
  for(const k of ['structural_strength','current_propulsion','why_not_wait','uncertainty','invalidation'])short(p[k]);
  for(const k of ['dynamic_evidence','dynamic_risks'])few(p[k]);
  const why=p.why_buy_now?.properties;
  if(why){short(why.summary);few(why.flow);few(why.orderbook);
    for(const horizon of Object.values(why.horizons.properties)){short(horizon.properties.summary);few(horizon.properties.evidence,1);}}
  const arbitration=p.arbitration?.properties;
  if(arbitration){short(arbitration.reason);for(const k of ['adopted','rejected','supporting','opposing'])few(arbitration[k]);few(arbitration.considered,6);}
  return result;
}
