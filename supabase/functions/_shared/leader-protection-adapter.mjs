import {createNativeProtection} from './leader-native-protection.mjs';
/** Existing position row is the atomic accounting/receipt journal. No migration. */
export function createPositionProtectionStore(db) {
 const snapshots=new Map();
 return {
  async load(id){
   const {data:r,error}=await db.from('v11_long_regime_positions').select('*').eq('id',id).single();
   if(error||!r)throw Error('V17_PROTECTION_POSITION_READ');
   snapshots.set(id,r);const metadata=r.metadata??{},stored=metadata.exitProtection??{};
   return {version:stored.version??0,position:{id:r.id,symbol:r.symbol,side:r.side,
    strategy:metadata.executionMode,manual:metadata.v17ManualPosition===true,
    remainingQuantity:Number(r.remaining_quantity),entryPrice:Number(r.entry_price),
    realizedPnl:Number(r.realized_pnl_usdt),exitPrice:r.exit_price,state:r.state,
    closedAt:r.closed_at?Date.parse(r.closed_at):null},
    protection:{generation:0,orders:[],health:'NONE',...stored}};
  },
  async compareAndSwap(id,expected,next){
   const old=snapshots.get(id);if(!old||(old.metadata?.exitProtection?.version??0)!==expected)return false;
   const p=next.position,now=new Date(Math.max(Date.now(),Date.parse(old.updated_at)+1)).toISOString(),patch={
    remaining_quantity:p.remainingQuantity,realized_pnl_usdt:p.realizedPnl,
    state:p.state,exit_price:p.exitPrice,closed_at:p.closedAt?new Date(p.closedAt).toISOString():null,
    exit_reason:p.state==='CLOSED'&&old.state!=='CLOSED'?'V17_NATIVE_STOP':old.exit_reason,
    metadata:{...old.metadata,exitProtection:{...next.protection,version:next.version}},updated_at:now};
   const {data,error}=await db.from('v11_long_regime_positions').update(patch)
    .eq('id',id).eq('updated_at',old.updated_at).select('*').maybeSingle();
   if(error)throw Error('V17_PROTECTION_POSITION_WRITE');if(!data)return false;
   snapshots.set(id,data);return true;
  }
 };
}
/** Instantiate inside the existing executor lease. Construction causes no IO. */
export function createGatewayProtection(db,gateway,verifyLease) {
 const store=createPositionProtectionStore(db),bindings=new Map();
 const exchange={
  async queryStop(clientAlgoId,symbol){const a=await gateway({action:'v17_query_stop',clientAlgoId,symbol});
   if(a.actualOrderId)bindings.set(String(a.actualOrderId),{clientAlgoId,symbol});return a;},
  async createStop(params){await verifyLease();return gateway({action:'v17_create_stop',params});},
  async cancelStop(clientAlgoId,symbol){await verifyLease();return gateway({action:'v17_cancel_stop',clientAlgoId,symbol});},
  async getFill(actualOrderId,symbol){const b=bindings.get(String(actualOrderId));
   if(!b||b.symbol!==symbol)throw Error('V17_FILL_NOT_BOUND_TO_STOP');
   return gateway({action:'v17_stop_fill',actualOrderId,...b});}
 };
 return createNativeProtection({store,exchange});
}
