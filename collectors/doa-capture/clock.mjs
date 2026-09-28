export const CLOCK_VERSION='TOP20_CLOCK_CAPTURE_1';
/** Transport starts early; only the boundary seed and 24 window buckets persist. */
export function captureDisposition(roles,window,now){
 if(window?.version!==CLOCK_VERSION)return {connect:true,persist:true};
 if(roles?.includes('OPEN_POSITION')||roles?.includes('MARKET_SENSOR'))return {connect:true,persist:true};
 const slot=window.slot_ms,start=slot-120000,bucket=Math.floor(now/5000)*5000;
 if(!Number.isSafeInteger(slot)||slot%600000!==0)return {connect:false,persist:false};
 return {connect:now>=start-60000&&now<slot+1000,persist:bucket>=start&&bucket<=slot};
}
