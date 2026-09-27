import {readFileSync,writeFileSync} from 'node:fs';
const [input,output]=process.argv.slice(2),r=JSON.parse(readFileSync(input));
if(!r.ok||r.binance?.positionsComplete!==true||r.binance?.openOrdersComplete!==true||
 r.dynamicLifecycle?.version!=='DYNAMIC_FLOW_LIFECYCLE_1'||r.nativeStopEnabled!==true)
 throw Error('READINESS_FAILED');
writeFileSync(output,JSON.stringify({
 ok:r.ok,observedAt:r.observedAt,patch:r.patch,
 binance:{positionsComplete:r.binance.positionsComplete,openOrdersComplete:r.binance.openOrdersComplete,
 positionCount:r.binance.positionCount,ordinaryOrderCount:r.binance.ordinaryOrderCount,conditionalOrderCount:r.binance.conditionalOrderCount},
 db:{openPositionCount:r.db?.openPositionCount,unresolvedOrderCount:r.db?.unresolvedOrderCount},
 runtime:{circuit_open:r.runtime?.circuit_open,protection_health:r.runtime?.protection_health,last_cycle_completed_at:r.runtime?.last_cycle_completed_at},
 openaiKeyPresent:r.openaiKeyPresent,deepseekKeyPresent:r.deepseekShadow?.keyPresent,
 nativeStopEnabled:r.nativeStopEnabled,dynamicLifecycle:r.dynamicLifecycle,
 protectionArbitration:r.protectionArbitration,sizing:r.sizing,
 testOrders:0,balancesAndPositionIdentifiersOmitted:true
},null,2)+'\n');
