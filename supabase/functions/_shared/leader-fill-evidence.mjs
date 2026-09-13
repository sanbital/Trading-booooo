/** Canonical, side-effect-free fill evidence shared by every V17 settlement path. */
const n=x=>Number(x);
const close=(a,b)=>Number.isFinite(n(a))&&Number.isFinite(n(b))&&
  Math.abs(n(a)-n(b))<=Math.max(1e-10,Math.abs(n(b))*1e-8);

export function dedupeEvidence(rows,{identity,fingerprint}={}) {
  const unique=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    const id=String(identity(row)??'');
    if(!id)return {exact:false,reason:'TRADE_ID_MISSING',rows:[]};
    const mark=String(fingerprint(row));
    if(unique.has(id)&&unique.get(id).fingerprint!==mark)
      return {exact:false,reason:'CONFLICTING_DUPLICATE_TRADE',rows:[]};
    unique.set(id,{row,fingerprint:mark});
  }
  return {exact:true,rows:[...unique.entries()].sort(([a],[b])=>a.length-b.length||a.localeCompare(b)).map(([,x])=>x.row)};
}

export function canonicalOrderFills(rows,{expectedQuantity,expectedSide=null,feeAsset='USDT'}={}) {
  const normalized=dedupeEvidence(rows,{
    identity:t=>t?.tradeId??t?.id,
    fingerprint:t=>[t?.qty,t?.price,t?.commission,t?.commissionAsset,t?.time,t?.side??''].join('|')
  });
  if(!normalized.exact)return {...normalized,quantity:0,funds:0,fee:0,lastAt:null,tradeIds:[]};
  let quantity=0,funds=0,fee=0,lastAt=0;
  for(const t of normalized.rows){
    const q=n(t?.qty),price=n(t?.price),commission=n(t?.commission),at=n(t?.time);
    if(!(q>0)||!(price>0)||!Number.isFinite(commission)||commission<0||!Number.isFinite(at)||
      t?.commissionAsset!==feeAsset||(expectedSide&&String(t?.side??expectedSide).toUpperCase()!==expectedSide))
      return {exact:false,reason:'TRADE_DETAILS_INCOMPLETE',rows:normalized.rows,quantity:0,funds:0,fee:0,lastAt:null,tradeIds:[]};
    quantity+=q;funds+=q*price;fee+=commission;lastAt=Math.max(lastAt,at);
  }
  const exact=normalized.rows.length>0&&close(quantity,expectedQuantity);
  return {exact,reason:exact?null:'TRADE_QUANTITY_INCOMPLETE',rows:normalized.rows,quantity,funds,fee,
    lastAt:lastAt||null,tradeIds:normalized.rows.map(t=>String(t?.tradeId??t?.id))};
}

export function cumulativeFillDelta({previousQuantity=0,previousFunds=0,previousFee=0,
  quantity,funds,fee,maxQuantity=Number.MAX_VALUE,maxDelta=Number.MAX_VALUE}={}) {
  const values=[previousQuantity,previousFunds,previousFee,quantity,funds,fee,maxQuantity,maxDelta].map(n);
  if(values.some(x=>!Number.isFinite(x))||values.some(x=>x<0))throw Error('FILL_CUMULATIVE_VALUE_INVALID');
  const [pq,pf,pc,q,f,c,mx,md]=values,dq=q-pq,df=f-pf,dc=c-pc;
  if(dq< -1e-10||df< -1e-10||dc< -1e-10||q>mx+1e-8||dq>cumulativeMax(mx,md)+1e-8)
    throw Error('FILL_CUMULATIVE_REGRESSION_OR_OVERFLOW');
  return {quantity:dq,funds:df,fee:dc};
}
function cumulativeMax(maxQuantity,maxDelta){return Math.min(maxQuantity,maxDelta);}
