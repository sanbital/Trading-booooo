// Authenticated gateway observation of an unchanged account across one live
// user-stream generation. REST recovery timestamps are retained, never restamped.
const stamp=x=>Number.isSafeInteger(x)&&x>0;
export function freshAccountStream(o,now=Date.now(),maxAge=3000){
 const c=o?.continuity;
 return o?.source==='BINANCE_ACCOUNT_STREAM'&&typeof o.id==='string'&&o.id.length>0&&
  stamp(o.requested_at_ms)&&stamp(o.received_at_ms)&&o.requested_at_ms<=o.received_at_ms&&
  now>=o.received_at_ms&&now-o.requested_at_ms<=maxAge&&
  c?.connected===true&&c.synchronized===true&&Number.isSafeInteger(c.generation)&&c.generation>0&&
  Number.isSafeInteger(c.revision)&&c.revision>=0&&typeof c.snapshot_id==='string'&&c.snapshot_id.length>0&&
  stamp(c.validated_at_ms)&&c.validated_at_ms===o.received_at_ms&&
  stamp(c.last_pong_at_ms)&&c.last_pong_at_ms<=c.validated_at_ms&&now-c.last_pong_at_ms<=maxAge&&
  stamp(c.snapshot_requested_at_ms)&&stamp(c.snapshot_received_at_ms)&&
  c.snapshot_requested_at_ms<=c.snapshot_received_at_ms&&c.snapshot_received_at_ms<=c.validated_at_ms&&
  Number.isSafeInteger(c.max_snapshot_age_ms)&&c.max_snapshot_age_ms>0&&c.max_snapshot_age_ms<=900000&&
  now-c.snapshot_received_at_ms<=c.max_snapshot_age_ms;
}
