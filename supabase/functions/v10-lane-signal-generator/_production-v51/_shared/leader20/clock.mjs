/** Entry evidence is fixed to [HH:x8, HH:(x+1)0]. Holdings use live evidence. */
export const CLOCK_VERSION='TOP20_CLOCK_CAPTURE_1';
export const SLOT_MS=600000, CAPTURE_MS=120000, PREWARM_MS=60000, EXECUTION_MS=120000;
// v153: batch -> last GPT FINAL p95 66,835ms (two completed slots); retain 13s
// for dispatch/safety and tail latency. SQL owns the configurable same reserve.
export const DECISION_RESERVE_MS=80000;
export const slotFloor=at=>Math.floor(at/SLOT_MS)*SLOT_MS;
export function clockDecisionWindow(at,reserveMs=DECISION_RESERVE_MS){
 if(!Number.isSafeInteger(reserveMs)||reserveMs<30000||reserveMs>=EXECUTION_MS)throw Error('CLOCK_DECISION_RESERVE_INVALID');
 const slot=slotFloor(at),deadline=slot+EXECUTION_MS;
 return {slot_ms:slot,capture_start_ms:slot-CAPTURE_MS,capture_end_ms:slot,
  decision_deadline_ms:deadline,decision_reserve_ms:reserveMs,latest_batch_start_ms:deadline-reserveMs};
}
export const preparationSlot=at=>slotFloor(at+CAPTURE_MS+PREWARM_MS);
export function clockCaptureValid(c,at){
 const w=c?.entry_window;
 return w?.version===CLOCK_VERSION && Number.isSafeInteger(w.slot_ms) && w.slot_ms%SLOT_MS===0 &&
  w.expires_at_ms===w.slot_ms+EXECUTION_MS && Number.isSafeInteger(at) && at>=w.slot_ms && at<w.expires_at_ms &&
  Number.isSafeInteger(c.start_ms) && Number.isSafeInteger(c.end_ms) &&
  c.start_ms>=w.slot_ms-CAPTURE_MS && c.start_ms<w.slot_ms-CAPTURE_MS+1000 &&
  c.end_ms>=w.slot_ms && c.end_ms<w.slot_ms+1000 && c.end_ms<=at &&
  c.trajectory?.length===24 && c.trajectory.every((p,i)=>p.bucket_ms===w.slot_ms-CAPTURE_MS+(i+1)*5000);
}
// JSONB journals reorder object keys. Compare every value and array position,
// without treating serialization order or a supplied hash as evidence identity.
function sameEvidence(a,b){
 if(a===b)return typeof a!=='number'||Number.isFinite(a);
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameEvidence(v,b[i]));
 const keys=Object.keys(a);
 return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameEvidence(a[k],b[k]));
}
export function sameClockCapture(a,b,at){
 return clockCaptureValid(a,at)&&clockCaptureValid(b,at)&&a.entry_window.slot_ms===b.entry_window.slot_ms &&
  sameEvidence(a.entry_window,b.entry_window)&&a.start_ms===b.start_ms&&a.end_ms===b.end_ms&&sameEvidence(a.trajectory,b.trajectory);
}
