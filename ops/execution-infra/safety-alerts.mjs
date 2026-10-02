export function evaluateSafetyMetrics(m,{now=Date.now()}={}){
 const alerts=[];for(const key of ['final_buy_dispatch_missing','unclaimed_deadline','expired_ready','busy_terminal','unknown_order','unknown_dispatch','protection_evidence_missing','active_subminute_cron','dual_scheduler','cron_startup_timeout'])if(Number(m?.[key])>0)alerts.push(key.toUpperCase());
 const r=m?.runtime;if(r?.circuit_open)alerts.push(r.incident_kind==='MANUAL_REVIEW_REQUIRED'?'CIRCUIT_MANUAL_REVIEW_REQUIRED':'CIRCUIT_ENTRY_FROZEN');
 const w=m?.writer;if(w?.owner&&Date.parse(w.expires_at)>now&&(!w.heartbeat_at||now-Date.parse(w.heartbeat_at)>15000))alerts.push('WRITER_HEARTBEAT_STALE');
 const s=m?.scheduler;if(s?.enabled&&(!s.heartbeat_at||now-Date.parse(s.heartbeat_at)>15000))alerts.push('SCHEDULER_HEARTBEAT_STALE');
 if(s?.enabled&&Date.parse(s.recovered_postmaster_at)!==Date.parse(m.postmaster_at))alerts.push('POSTMASTER_RECOVERY_ENTRY_FROZEN');
 if(Number(m?.db_connections)>=Number(m?.db_connection_limit)*.9)alerts.push('DB_CONNECTION_HEADROOM_LOW');
 if(Number(m?.net_queue_depth)>100)alerts.push('PG_NET_QUEUE_BACKLOG');
 return alerts;
}
