export const CLOCK_VERSION='TOP20_CLOCK_CAPTURE_1';
/**
 * Transport starts early and preserves the immutable 24-bucket entry path.
 * After T0, keep the same Top20 streams for the bounded executor validity
 * window so a BUY is checked against a fresh rolling trajectory. This tail is
 * capture-only: entry authority and the original T0 snapshot stay unchanged.
 */
export function captureDisposition(roles,window,now){
 if(window?.version!==CLOCK_VERSION)return {connect:true,persist:true};
 if(roles?.includes('OPEN_POSITION')||roles?.includes('MARKET_SENSOR'))return {connect:true,persist:true};
 const slot=window.slot_ms,start=slot-120000,bucket=Math.floor(now/5000)*5000;
 if(!Number.isSafeInteger(slot)||slot%600000!==0)return {connect:false,persist:false};
 const inValidityTail=now<slot+120000;
 return {connect:now>=start-60000&&inValidityTail,persist:bucket>=start&&inValidityTail};
}
