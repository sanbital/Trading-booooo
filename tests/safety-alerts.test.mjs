import test from 'node:test';import assert from 'node:assert/strict';import {evaluateSafetyMetrics}from'../ops/execution-infra/safety-alerts.mjs';
test('actual missing/expired/unknown/protection and scheduler generations generate explicit alerts',()=>{
 const now=Date.now(),postmaster_at=new Date(now-60000).toISOString(),base={postmaster_at,scheduler:{enabled:true,heartbeat_at:new Date(now).toISOString(),recovered_postmaster_at:postmaster_at},db_connections:20,db_connection_limit:90};assert.deepEqual(evaluateSafetyMetrics(base,{now}),[]);
 assert.deepEqual(evaluateSafetyMetrics({...base,unclaimed_deadline:1,unknown_order:1,protection_evidence_missing:1},{now}),['UNCLAIMED_DEADLINE','UNKNOWN_ORDER','PROTECTION_EVIDENCE_MISSING']);
 const a=evaluateSafetyMetrics({...base,scheduler:{enabled:true,heartbeat_at:new Date(now-20000).toISOString(),recovered_postmaster_at:'old'},dual_scheduler:1},{now});assert.ok(a.includes('DUAL_SCHEDULER'));assert.ok(a.includes('SCHEDULER_HEARTBEAT_STALE'));assert.ok(a.includes('POSTMASTER_RECOVERY_ENTRY_FROZEN'));
});

test('manual circuit and active writer heartbeat failure raise explicit alerts',()=>{
 const now=Date.parse('2026-10-02T12:00:00Z');
 assert.deepEqual(evaluateSafetyMetrics({runtime:{circuit_open:true,incident_kind:'MANUAL_REVIEW_REQUIRED'},writer:{owner:'writer',expires_at:'2026-10-02T12:00:10Z',heartbeat_at:'2026-10-02T11:59:40Z'}},{now}),['CIRCUIT_MANUAL_REVIEW_REQUIRED','WRITER_HEARTBEAT_STALE']);
 assert.deepEqual(evaluateSafetyMetrics({writer:{owner:null,expires_at:'2026-10-02T12:00:10Z'}},{now}),[]);
});
