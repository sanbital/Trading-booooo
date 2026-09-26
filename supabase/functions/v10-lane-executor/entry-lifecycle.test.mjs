import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TERMINAL_CLASS,agedOutReason,expiredTriggerReason,gptTerminalReason,lifecycleNote,noteChanged,terminalClassOf} from './entry-lifecycle.mjs';

test('every entry outcome maps to exactly one of the published terminal classes',()=>{
  const cases={FILLED:[['X',{filled:true}]],PARTIAL_FILLED:[['PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED'],['X',{filled:true,partial:true}]],
    GPT_REJECTED:[['GPT_SKIP:EV_UNFAVORABLE'],['GPT_ABSTAIN:DATA_INSUFFICIENT'],['GPT_TIMEOUT'],['GPT_FINAL_RECHECK_SKIP'],['GPT_FINAL_RECHECK_ABSTAIN:RC_EXPIRED']],
    EXECUTION_REJECTED:[['UNKNOWN:E1_QUOTE_UNKNOWN'],['EXECUTION_SAFETY_REJECT:STALE_QUOTE'],['BOO_ENTRY_GATE:X'],['ENTRY_CONTROL:ACCOUNT:X'],['RC_POST_SPREAD_CATASTROPHIC'],['EXECUTION_REJECTED:GPT_BUY_NOT_EXECUTED:X']],
    IOC_NO_FILL:[['IOC_NO_FILL:EXPIRED'],['IOC_RETRY_EXHAUSTED'],['IOC_RETRY_EXHAUSTED:CYCLE_BUDGET_RESERVE']],
    SLOT_UNAVAILABLE:[['V11_SLOT_FULL'],['DUPLICATE_SYMBOL_OPEN'],['SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:V11_SLOT_FULL'],['V17_SETUP_POLICY_SLOT_LIMIT'],['ENTRY_MARGIN_INSUFFICIENT:1:2'],
      // (2026-09-25) multi-slot capacity stops noted on the BUYs a run could not admit
      ['MAX_SLOTS_REACHED:10/10'],['INSUFFICIENT_MARGIN:149.50<152.13'],['PENDING_CAPITAL_RESERVED:PENDING_ORDER_IDENTITY:1'],
      ['SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:INSUFFICIENT_MARGIN:149.50<152.13']],
    STALE:[[''],['STALE:TRIGGER_WINDOW_CLOSED'],['GPT_REVIEW_EXPIRED'],['GPT_BUY_NOT_EXECUTED:V17_SETUP_EXPIRED'],['E1_DISPATCH_QUOTE_AGED:1400'],['ENTRY_PER_RUN_LIMIT'],
      ['EXECUTION_SAFETY_REJECT:CYCLE_BUDGET_RESERVE'],['EXECUTION_SAFETY_REJECT:ENTRY_RUN_BUDGET_EXHAUSTED']],
    ERROR:[['SETUP_WRITE:x'],['V17_RUNTIME_BLOCKED'],['CLAIM:x'],['GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR'],['E1_SIGNAL_TERMINAL_WRITE'],
      ['ACCOUNT_SAFETY_BLOCK:CAPACITY_REFRESH_FAILED:GATEWAY_TIMEOUT']],
    STRATEGY_REJECTED:[['V17_SETUP_EXPIRED'],['V17_CHASE_EXPIRED:DEAD:VOLUME_FADING'],['V30_FRONT_REJECT:volumeTails']]};
  for(const [cls,list] of Object.entries(cases)){assert.ok(Object.values(TERMINAL_CLASS).includes(cls));
    for(const [reason,opt] of list)assert.equal(terminalClassOf(reason,opt),cls,`${reason} -> ${cls}`);}
});

test('a GPT review is terminal only when it can never become an entry for this trigger',()=>{
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_SKIP',decision:'SKIP',detail:'SELL_DOMINANCE,MOMENTUM_FADED'}),'GPT_SKIP:SELL_DOMINANCE,MOMENTUM_FADED');
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_SKIP_AGED',decision:'SKIP'}),'GPT_SKIP');
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_ABSTAIN',decision:'ABSTAIN',detail:'EXECUTION_UNSAFE'}),'GPT_ABSTAIN:EXECUTION_UNSAFE');
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_NO_VALID_API_RESPONSE',decision:'ABSTAIN',error:'API_TIMEOUT'}),'GPT_TIMEOUT');
  // R181: a failed answer names its source and never reads as a GPT ABSTAIN (same GPT_REJECTED class).
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_NO_VALID_API_RESPONSE',decision:'ABSTAIN',error:'HTTP_500'}),'GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_500');
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_NO_VALID_API_RESPONSE',decision:'ABSTAIN',error:'FD_BUY_WITH_REASON'}),'GPT_NO_VALID_API_RESPONSE:SAFETY_FALLBACK:FD_BUY_WITH_REASON');
  assert.equal(terminalClassOf('GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429'),'GPT_REJECTED');
  for(const reason of ['GPT_REVIEW_PENDING','GPT_TRIGGER_EXPIRED','GPT_STALE_OR_FUTURE_REVIEW','GPT_API_BUDGET_EXHAUSTED',
    'GPT_REVIEW_NOT_CONFIGURED_OR_APPROVED','GPT_REVIEW_STORAGE_OR_VALIDATION_ERROR','BASELINE_REJECT_OR_INVALID'])
    assert.equal(gptTerminalReason({allowed:false,reason,decision:'ABSTAIN'}),null,reason+' is transient');
  assert.equal(gptTerminalReason({allowed:true,reason:'GPT_BUY',decision:'BUY'}),null);
  assert.equal(gptTerminalReason({allowed:false,reason:'GPT_SKIP',decision:'BUY'}),null,'decision and reason must agree');
});

test('a closed trigger window is named by the last recorded outcome; nothing ends without a reason',()=>{
  const n=(reason,gptDecision=null)=>lifecycleNote({at:1,stage:'X',reason,gptDecision});
  assert.equal(expiredTriggerReason(null),'STALE:TRIGGER_WINDOW_CLOSED');
  assert.equal(expiredTriggerReason(n('GPT_REVIEW_EXPIRED','BUY')),'STALE:GPT_BUY_NOT_EXECUTED:GPT_REVIEW_EXPIRED');
  assert.equal(expiredTriggerReason(n('GPT_REVIEW_PENDING')),'STALE:GPT_REVIEW_PENDING');
  assert.equal(expiredTriggerReason(n('V11_SLOT_FULL','BUY')),'SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:V11_SLOT_FULL');
  assert.equal(expiredTriggerReason(n('V17_SETUP_POLICY_SLOT_LIMIT')),'SLOT_UNAVAILABLE:V17_SETUP_POLICY_SLOT_LIMIT');
  assert.equal(expiredTriggerReason(n('UNKNOWN:E1_QUOTE_UNKNOWN','BUY')),'EXECUTION_REJECTED:GPT_BUY_NOT_EXECUTED:UNKNOWN:E1_QUOTE_UNKNOWN');
  assert.equal(expiredTriggerReason(n('ENTRY_PER_RUN_LIMIT','BUY')),'STALE:GPT_BUY_NOT_EXECUTED:ENTRY_PER_RUN_LIMIT');
  assert.equal(expiredTriggerReason(n('SETUP_WRITE:x','BUY')),'ERROR:GPT_BUY_NOT_EXECUTED:SETUP_WRITE:x');
  for(const note of [null,n('GPT_REVIEW_EXPIRED','BUY'),n('V11_SLOT_FULL','BUY'),n('UNKNOWN:E1_QUOTE_UNKNOWN','BUY')])
    assert.notEqual(terminalClassOf(expiredTriggerReason(note)),TERMINAL_CLASS.STRATEGY_REJECTED,'a triggered candidate is never labelled a V17 rejection');
  assert.equal(agedOutReason('ARMED',null),'V17_SETUP_EXPIRED:AGED_OUT_UNCONCLUDED');
  assert.equal(agedOutReason(null,null),'STALE:SIGNAL_AGED_OUT');
  assert.equal(agedOutReason('TRIGGERED',n('V11_SLOT_FULL','BUY')),'SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:V11_SLOT_FULL');
  assert.equal(expiredTriggerReason(n('x'.repeat(900))).length<=500,true);
  assert.equal(noteChanged(n('A'),n('A')),false);assert.equal(noteChanged(n('A'),n('B')),true);assert.equal(noteChanged(null,n('A')),true);
  assert.equal(lifecycleNote({at:1,stage:'S',reason:'R',gptDecision:'MAYBE'}).gptDecision,null);
});

test('BUY orphan prevention: every openBull refusal returns its claim, is terminal, or was written terminal',()=>{
  const src=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
  const open=src.slice(src.indexOf('async function openBull('),src.indexOf('// Best-effort feed for the decision-only exit shadow.'));
  const refusals=[...open.matchAll(/return\s*\{\s*entered:false/g)];
  assert.ok(refusals.length>=20);
  // The returned object literal, brace-matched (template literals hold no braces here but ${}).
  const objectAt=i=>{let depth=0,k=open.indexOf('{',i);const start=k;
    for(;k<open.length;k++){const c=open[k];if(c==='{')depth++;else if(c==='}'&&--depth===0)break;}
    return open.slice(start,k+1);};
  for(const m of refusals){
    const obj=objectAt(m.index),before=open.slice(Math.max(0,m.index-420),m.index);
    assert.ok(/releaseClaim:true|terminal:"/.test(obj)||/status:"REJECTED"/.test(before),
      'refusal without a claim release, terminal or terminal write: '+obj.slice(0,160));
  }
  // and the queue turns each of those into a state with a reason.
  const queue=src.slice(src.indexOf('async function runEntryQueue('),src.indexOf('async function requireLeaderEntryControls'));
  assert.match(queue,/if\(entry\?\.terminal&&entry\?\.entered!==true\)/);
  assert.match(queue,/entryLifecycle:lifecycleNote\(\{at:Date\.now\(\),stage:"EXECUTION",reason:entry\.reason/);
  assert.match(queue,/sweepEntryLifecycle\(db,Date\.now\(\)\)/);
});

test('the lifecycle sweep retires only closed triggers and aged-out rows, only NEW -> REJECTED, with a named reason',async()=>{
  const vm=await import('node:vm'),lifecycle=await import('./entry-lifecycle.mjs'),settlement=await import('./gpt-terminal-settlement.mjs');
  const src=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
  const fn=src.slice(src.indexOf('async function sweepEntryLifecycle('),src.indexOf('/**',src.indexOf('async function sweepEntryLifecycle(')));
  const now=Date.parse('2026-09-25T12:00:00Z'),MIN=60000,writes=[],audits=[];
  const rows=[
    {id:'closed-buy',symbol:'TRBUSDT',entry_bar_at:new Date(now-10*MIN).toISOString(),setup_state:'TRIGGERED',trigger_expires_at:String(now-1000),
      note:{reason:'ENTRY_PER_RUN_LIMIT',gptDecision:'BUY'}},
    {id:'live',symbol:'ABCUSDT',entry_bar_at:new Date(now-6*MIN).toISOString(),setup_state:'TRIGGERED',trigger_expires_at:String(now+20000),note:null},
    {id:'old-armed',symbol:'OLDUSDT',entry_bar_at:new Date(now-60*MIN).toISOString(),setup_state:'ARMED',trigger_expires_at:null,note:null},
    {id:'old-legacy',symbol:'LEGUSDT',entry_bar_at:new Date(now-9*24*60*MIN).toISOString(),setup_state:null,trigger_expires_at:null,note:null}];
  const db={from:table=>{const q={filters:[],patch:null};const b={
    select:()=>b,eq:(k,v)=>{q.filters.push(['eq',k,v]);return b;},lt:(k,v)=>{q.filters.push(['lt',k,v]);return b;},
    gte:(k,v)=>{q.filters.push(['gte',k,v]);return b;},order:()=>b,update:p=>{q.patch=p;return b;},
    // No stored GPT answer for these rows: the sweep falls back to the in-cycle note (R181 fallback path).
    limit:async()=>{if(table==='gpt_final_entry_reviews')return {data:[],error:null};const lt=q.filters.find(f=>f[0]==='lt'),gte=q.filters.find(f=>f[0]==='gte'),trig=q.filters.find(f=>f[1]==='features->v17Setup->>state');
      return {data:rows.filter(r=>(!lt||r.entry_bar_at<lt[2])&&(!gte||r.entry_bar_at>=gte[2])&&(!trig||r.setup_state===trig[2])),error:null};},
    then:(res,rej)=>{writes.push({id:q.filters.find(f=>f[1]==='id')?.[2],patch:q.patch,guard:q.filters.find(f=>f[1]==='status')?.[2]});
      return Promise.resolve({error:null}).then(res,rej);}};return b;}};
  const ctx={db,Date,Promise,Error,Number,String,console,...lifecycle,lifecycleTerminalReason:settlement.lifecycleTerminalReason,N:(v,d=0)=>Number.isFinite(Number(v))&&v!==null?Number(v):d,
    SIGNAL_MAX:20*MIN,REVISION:'R',STRATEGY:'S',SETUP_STATE:{TRIGGERED:'TRIGGERED'},audit:async(...a)=>{audits.push(a);}};
  vm.createContext(ctx);vm.runInContext(fn+';this.sweep=sweepEntryLifecycle;',ctx);
  const retired=await ctx.sweep(db,now);
  assert.deepEqual(Array.from(retired,r=>r.signalId).sort(),['closed-buy','old-armed','old-legacy']); // main-realm copy of a vm array
  const by=Object.fromEntries(writes.map(w=>[w.id,w]));
  assert.equal(by['closed-buy'].patch.reject_reason,'STALE:GPT_BUY_NOT_EXECUTED:ENTRY_PER_RUN_LIMIT');
  assert.equal(by['old-armed'].patch.reject_reason,'V17_SETUP_EXPIRED:AGED_OUT_UNCONCLUDED');
  assert.equal(by['old-legacy'].patch.reject_reason,'STALE:SIGNAL_AGED_OUT');
  assert.ok(!by.live,'a live trigger is untouched');
  for(const w of writes){assert.equal(w.patch.status,'REJECTED');assert.equal(w.guard,'NEW','only a NEW row can be retired');}
  assert.equal(audits.length,3);assert.ok(audits.every(a=>a[6].stage==='ENTRY_LIFECYCLE_TERMINAL'&&a[6].orderDispatched===false));
});
