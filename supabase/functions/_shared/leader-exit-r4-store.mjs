/** Existing-row adapter. No I/O until methods are called; no schema/permission changes.
 * The admission transaction must seed r4Journal and assign ONE exit owner first.
 * Do not run the legacy/native accounting writers independently on an R4 row.
 */
export function createR4PositionStore(db,positionId,{clock=Date.now}={}){
 let snapshot=null;
 function validate(row){
  const j=row?.metadata?.r4Journal;
  if(!row||row.id!==positionId||row.metadata.executionMode!=='LEADER_MOMENTUM_V17'||row.metadata.exitManager!=='R4_EVENT_WORKER'||
    row.metadata.v17ManualPosition===true||!j||j.positionId!==positionId||row.symbol!==j.symbol||row.side!=='LONG')throw Error('R4_STORE_OWNERSHIP');
  if(Math.abs(Number(row.remaining_quantity)-j.remainingQuantity)>1e-7||
    Math.abs(Number(row.realized_pnl_usdt)-j.realizedPnl)>1e-7||row.state!==j.state)throw Error('R4_STORE_ACCOUNTING_DRIFT');
  if(!Number.isFinite(Date.parse(row.updated_at)))throw Error('R4_STORE_INVALID_VERSION_TIME');
  return j;
 }
 return {
  async load(){
   const {data,error}=await db.from('v11_long_regime_positions').select('*').eq('id',positionId).single();
   if(error)throw Error('R4_STORE_READ');const j=validate(data);snapshot=data;return structuredClone(j);
  },
  async compareAndSwap(expected,next){
   if(!snapshot||snapshot.metadata.r4Journal.revision!==expected)return false;
   if(next.positionId!==positionId||next.revision!==expected+1||next.symbol!==snapshot.symbol)throw Error('R4_STORE_BAD_CAS');
   const stamp=new Date(Math.max(clock(),Date.parse(snapshot.updated_at)+1)).toISOString();
   const filled=next.originalQuantity-next.remainingQuantity;
   const patch={remaining_quantity:next.remainingQuantity,realized_pnl_usdt:next.realizedPnl,state:next.state,
    peak_price:Math.max(Number(snapshot.peak_price),next.engine.peak),
    exit_price:filled>0?next.exitQuote/filled:snapshot.exit_price,
    closed_at:next.state==='CLOSED'?new Date(next.lastFillAt??next.updatedAt).toISOString():null,
    exit_reason:next.state==='CLOSED'?'V17_R4_RECONCILED_EXIT':snapshot.exit_reason,
    metadata:{...snapshot.metadata,r4Journal:structuredClone(next)},updated_at:stamp};
   const {data,error}=await db.from('v11_long_regime_positions').update(patch).eq('id',positionId)
    .eq('updated_at',snapshot.updated_at).eq('metadata->>exitManager','R4_EVENT_WORKER').select('*').maybeSingle();
   if(error)throw Error('R4_STORE_WRITE');if(!data){snapshot=null;return false;}validate(data);snapshot=data;return true;
  }
 };
}
