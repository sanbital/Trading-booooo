export function assertPausedQuoteRepair(s){
 if(s.paused!==true||s.positions!==0||s.unresolved_orders!==0||s.circuit!==false||s.writers!==0)throw Error('QUOTE_REPAIR_PAUSED_FLAT_GATE');
}
export function assertQuoteRepairHealth(value,{app,expectedCommit}){
 const binance=app==='trading-booooo';
 if(!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app)||!/^[a-f0-9]{40}$/.test(expectedCommit)||value.deployment_commit!==expectedCommit||value.order_writer?.required!==true||value.scheduler_enabled!==!binance||value.external_scheduler?.enabled!==!binance||value.keys_configured?.binance_futures!==binance)throw Error('QUOTE_REPAIR_ROLE_OR_SOURCE_CHANGED');
}
