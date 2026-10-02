-- Read-only baseline report. Every row is one production decision_id/job_key.
-- Both windows share the same cutoff; order/position joins require the stored job key.
-- This report never classifies a legacy order.state=FILLED as a full fill by itself.
with bounds as (
  select '24h' period,statement_timestamp()-interval '24 hours' since,statement_timestamp() cutoff
  union all select '7d',statement_timestamp()-interval '7 days',statement_timestamp()
), finals as (
  select r.job_key decision_id,r.record#>>'{identity,signal_id}' signal_id,
    to_timestamp((r.record#>>'{result,completed_at_ms}')::numeric/1000) completed_at
  from public.gpt_final_entry_reviews r
  where r.purpose='PRODUCTION' and r.state='DONE' and r.valid is true and r.decision='BUY'
    and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3'
    and r.record#>>'{result,completed_at_ms}' ~ '^[0-9]+$'
    and upper(coalesce(r.record#>>'{result,origin}','')) not in ('TEST','REPLAY','DRYRUN','MOCK')
), cohort as (
  select b.*,f.* from bounds b join finals f on f.completed_at>=b.since and f.completed_at<b.cutoff
), facts as (
  select c.*,d.state dispatch_state,d.terminal_reason raw_terminal_reason,d.last_error,
    d.dispatch_requested_at,d.executor_claimed_at,d.valid_until,d.terminal_at,
    d.signal_id is not null dispatch_persisted,
    d.executor_claimed_at is not null and d.executor_claimed_at<=c.cutoff executor_claimed,
    coalesce(o.boundary_validated,false) validation_pass,
    x.clock_safety_result='PASS' and
      (x.trace->>'validity_result'='VALID' or
        (x.trace->>'validity_result'='UNCERTAIN' and x.trace->>'gpt_recheck_result'='KEEP_BUY')) market_validation_pass,
    x.order_sent_at is not null and x.order_sent_at<=c.cutoff submit_attempted,
    coalesce(o.accepted,false) exchange_acknowledged,coalesce(o.has_fill,false) partial_or_filled,
    coalesce(o.full_fill,false) fully_filled,coalesce(p.attributed,false) position_attributed,
    coalesce(p.protected,false) protection_installed,coalesce(p.closed,false) position_closed
  from cohort c
  left join public.leader20_execution_dispatches d on d.signal_id::text=c.signal_id and d.gpt_completed_at=c.completed_at
  left join public.leader20_clock_executions x on x.signal_id::text=c.signal_id and x.gpt_buy_completed_at=c.completed_at
  left join lateral (
    select bool_or(case when jsonb_typeof(o.response_payload#>'{v22EntryFinality,clockExecutionSafety,checked_at_ms}')='number'
        then to_timestamp((o.response_payload#>>'{v22EntryFinality,clockExecutionSafety,checked_at_ms}')::numeric/1000)
          between c.completed_at and least(d.valid_until,c.cutoff)
          and o.response_payload->>'notDispatched' is distinct from 'true'
          and (o.response_payload#>>'{v22EntryFinality,clockExecutionSafety,validity_result}'='VALID' or
            (o.response_payload#>>'{v22EntryFinality,clockExecutionSafety,validity_result}'='UNCERTAIN'
              and o.response_payload#>>'{v22EntryFinality,clockExecutionSafety,telemetry,gpt_recheck_result}'='KEEP_BUY'))
        else false end) boundary_validated,
      bool_or(o.exchange_order_id is not null) accepted,
      bool_or(case when jsonb_typeof(o.response_payload#>'{v22EntryFinality,executedQty}')='number'
        then (o.response_payload#>>'{v22EntryFinality,executedQty}')::numeric>0 else false end) has_fill,
      bool_or(o.response_payload#>>'{v22EntryFinality,finalStatus}'='FILLED' and
        case when jsonb_typeof(o.response_payload#>'{v22EntryFinality,executedQty}')='number'
          then (o.response_payload#>>'{v22EntryFinality,executedQty}')::numeric>=o.requested_quantity else false end) full_fill
    from public.v11_long_regime_orders o
    where o.signal_id::text=c.signal_id and o.intent='OPEN_LONG' and o.created_at<=c.cutoff
      and o.request_payload#>>'{entry_gpt_decision,jobKey}'=c.decision_id
  ) o on true
  left join lateral (
    select count(*)>0 attributed,bool_and(p.state='CLOSED') closed,
      bool_or(exists(select 1 from jsonb_array_elements(case
          when jsonb_typeof(p.metadata#>'{exitProtection,orders}')='array'
            then p.metadata#>'{exitProtection,orders}' else '[]'::jsonb end) protect
        where nullif(protect->>'algoId','') is not null
          and protect->>'status' not in ('SUBMITTING','REJECTED','UNKNOWN')
          and case when jsonb_typeof(protect->'ackAt')='number'
          then to_timestamp((protect->>'ackAt')::numeric/1000)<=c.cutoff else false end)) protected
    from public.v11_long_regime_positions p
    where p.signal_id::text=c.signal_id and p.entry_at<=c.cutoff and exists(
      select 1 from public.v11_long_regime_orders own where own.position_id=p.id and own.intent='OPEN_LONG'
        and own.created_at<=c.cutoff and own.request_payload#>>'{entry_gpt_decision,jobKey}'=c.decision_id)
  ) p on true
), classified as (
  select *,case
    when protection_installed and position_attributed then 'PROTECTED'
    when position_closed and position_attributed then 'POSITION_CLOSED_PROTECTION_NOT_REQUIRED'
    when not dispatch_persisted then 'DISPATCH_MISSING'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'EXECUTOR_BUSY' then 'EXECUTOR_BUSY'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'UNIVERSE.*STALE' then 'UNIVERSE_STALE'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'CIRCUIT' then 'CIRCUIT_OPEN'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'RATE.?LIMIT|HTTP_429' then 'RATE_LIMIT'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'DB.*TIMEOUT|CONNECTION.*TIMEOUT|DATABASE.*TIMEOUT' then 'DB_TIMEOUT'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'LEASE|FENCED' then 'LEASE_FAILURE'
    when not executor_claimed and valid_until<=cutoff then 'UNCLAIMED_DEADLINE_EXPIRED'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'AUTHORITY.*EXPIRED|GPT_REVIEW_EXPIRED|FINAL_EXPIRED' then 'AUTHORITY_EXPIRED'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'CAPACITY|SLOT_FULL|MARGIN_INSUFFICIENT' then 'CAPACITY_REJECTED'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'STALE|FRESHNESS|SNAPSHOT|CAPTURE|VALIDITY_CHECK' then 'LATEST_DATA_VALIDATION_FAILED'
    when coalesce(last_error,raw_terminal_reason,'') ~* 'EXCHANGE_REJECT' then 'EXCHANGE_REJECTED'
    when partial_or_filled and not position_attributed then 'FILL_ATTRIBUTION_MISSING'
    when position_attributed and not protection_installed then 'PROTECTION_EVIDENCE_MISSING'
    when dispatch_state in ('SUBMITTING','ORDER_SUBMITTING','UNKNOWN') then 'UNKNOWN_ORDER'
    when terminal_at is null and valid_until>cutoff then 'IN_FLIGHT'
    when terminal_at is not null and nullif(trim(last_error),'') is null
      and raw_terminal_reason in ('EXECUTION_WINDOW_INSUFFICIENT','REJECTED','EXPIRED') then 'TERMINAL_ERROR_CONTEXT_MISSING'
    else 'UNCLASSIFIED_TERMINAL_REASON' end reason
  from facts
)
select period,since utc_start,cutoff utc_cutoff,since at time zone 'Asia/Seoul' kst_start,
  cutoff at time zone 'Asia/Seoul' kst_cutoff,decision_id,completed_at,signal_id,
  dispatch_persisted,executor_claimed,coalesce(validation_pass,false) validation_pass,
  coalesce(market_validation_pass,false) market_validation_pass,
  submit_attempted,exchange_acknowledged,partial_or_filled,fully_filled,
  position_attributed,protection_installed,reason,raw_terminal_reason,last_error,
  case when reason in ('PROTECTED','POSITION_CLOSED_PROTECTION_NOT_REQUIRED') then 'SUCCESS'
    when reason='IN_FLIGHT' then 'PENDING'
    when reason in ('AUTHORITY_EXPIRED','CAPACITY_REJECTED','LATEST_DATA_VALIDATION_FAILED','EXCHANGE_REJECTED') then 'STRATEGIC_OR_VENUE_REFUSAL'
    when reason in ('UNCLASSIFIED_TERMINAL_REASON','TERMINAL_ERROR_CONTEXT_MISSING') then 'UNCLASSIFIED'
    else 'SYSTEM_FAILURE_OR_UNRESOLVED' end outcome_class,
  extract(epoch from executor_claimed_at-dispatch_requested_at)*1000 dispatch_to_claim_ms
from classified order by period,completed_at,decision_id
