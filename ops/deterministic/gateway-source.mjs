// A gateway-only rollout need not redeploy the independent Tokyo clock.
// Per-app pins are complete and reviewed; a missing pin never falls back.
export const GATEWAY_APPS=Object.freeze(['trading-booooo','trading-booooo-sanbital-gateway']);
export function expectedGatewayCommit(request,app){
 if(!GATEWAY_APPS.includes(app))throw Error('GATEWAY_SOURCE_APP');
 const mapped=Object.hasOwn(request,'gateway_commits'),pins=mapped?request.gateway_commits:null;
 if(mapped&&(!pins||GATEWAY_APPS.some(name=>!/^[a-f0-9]{40}$/.test(pins[name]??''))||Object.keys(pins).some(name=>!GATEWAY_APPS.includes(name))))throw Error('GATEWAY_SOURCE_PINS_INCOMPLETE');
 const commit=mapped?pins[app]:request.gateway_commit;
 if(!/^[a-f0-9]{40}$/.test(commit??''))throw Error('GATEWAY_SOURCE_COMMIT');
 return commit;
}
