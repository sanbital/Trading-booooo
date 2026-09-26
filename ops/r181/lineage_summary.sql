-- R181 follow-up: per-window lineage funnel with GPT decision_source split. SELECT-ONLY.
-- decision_source mirrors entry-lifecycle.mjs gptDecisionSource(); historical rows are not rewritten.
with w(label, since) as (
  values ('24h', now() - interval '24 hours'), ('48h', now() - interval '48 hours'), ('7d', now() - interval '7 days')
), ini as (
  select distinct on (r.signal_id) r.signal_id, r.decision, r.state, r.completed_at, r.created_at,
    case
      when r.state <> 'DONE' then 'PENDING'
      when r.valid is true and r.record->'result'->>'origin' = 'OPENAI_API' then 'GPT_VALID'
      when r.error = 'API_TIMEOUT' then 'TIMEOUT'
      when r.record->'result'->>'origin' = 'LOCAL_DATA_ERROR'
        or r.error in ('REVIEW_PREPARATION_FAILED','COUNTER_PREPARATION_FAILED','HISTORY_INVALID') then 'SYSTEM_ABORT'
      when r.error ~ '^HTTP_[0-9]+$' or r.error in ('FD_API_KEY_MISSING','FD_API_OR_VALIDATION_ERROR','FD_API_INCOMPLETE','FD_MODEL_MISMATCH') then 'PROVIDER_ERROR'
      when r.error in ('FD_RESPONSE_NOT_JSON','FD_RESPONSE_TOO_LARGE','FD_API_OUTPUT_COUNT','FD_UNEXPECTED_TOOL')
        or r.error ~ '^(TYPE|ENUM|STRING|REQUIRED|EXTRA|ARRAY):' then 'PARSE_ERROR'
      else 'SAFETY_FALLBACK'
    end as source
  from public.gpt_final_entry_reviews r
  where r.purpose = 'PRODUCTION' and r.record->>'kind' is null and coalesce(r.record->'packet'->>'task','ENTRY') = 'ENTRY'
    and r.record->>'wire_profile' = 'GPT_FINAL_DECISION_FD1:ENTRY'
  order by r.signal_id, r.created_at
), s as (
  select s.*, i.decision, i.source, i.completed_at as gpt_done,
    public.entry_terminal_class(s.reject_reason, false, false) as reason_class
  from public.v11_long_regime_signals s left join ini i on i.signal_id = s.id::text
)
select w.label,
  (select count(*) from s where s.created_at >= w.since) as signals,
  (select count(*) from s where s.created_at >= w.since and s.source is not null) as gpt_reviewed_opportunities,
  (select count(*) from s where s.created_at >= w.since and s.source = 'GPT_VALID' and s.decision = 'BUY') as gpt_buy,
  (select count(*) from s where s.created_at >= w.since and s.source = 'GPT_VALID' and s.decision = 'SKIP') as gpt_skip,
  (select count(*) from s where s.created_at >= w.since and s.source = 'GPT_VALID' and s.decision = 'ABSTAIN') as valid_abstain,
  (select count(*) from s where s.created_at >= w.since and s.source = 'PROVIDER_ERROR') as provider_error,
  (select count(*) from s where s.created_at >= w.since and s.source = 'TIMEOUT') as timeout,
  (select count(*) from s where s.created_at >= w.since and s.source = 'PARSE_ERROR') as parse_error,
  (select count(*) from s where s.created_at >= w.since and s.source = 'SAFETY_FALLBACK') as safety_fallback,
  (select count(*) from s where s.created_at >= w.since and s.source = 'SYSTEM_ABORT') as system_abort,
  (select count(*) from s where s.created_at >= w.since and s.source = 'PENDING') as pending,
  (select count(*) from public.v11_long_regime_orders o where o.created_at >= w.since and o.intent = 'OPEN_LONG'
     and (o.exchange_order_id is not null or o.state = 'FILLED')) as entry_orders_dispatched,
  (select count(distinct o.signal_id) from public.v11_long_regime_orders o where o.created_at >= w.since and o.intent = 'OPEN_LONG'
     and (o.exchange_order_id is not null or o.state = 'FILLED')) as signals_with_entry_order,
  (select count(*) from public.exchange_trade_fills f where f.executed_at >= w.since and f.exchange = 'binance_futures'
     and f.source = 'AUTOMATED' and f.side = 'BUY') as entry_fills,
  (select count(*) from public.v11_long_regime_positions p where p.created_at >= w.since) as positions_opened,
  (select count(*) from public.v11_long_regime_positions p where p.closed_at >= w.since and p.state = 'CLOSED') as positions_closed,
  (select count(*) from s where s.created_at >= w.since and s.status = 'REJECTED' and s.decision is distinct from 'BUY'
     and s.gpt_done is not null and s.gpt_done < s.updated_at and s.reason_class <> 'GPT_REJECTED') as gpt_nonbuy_mislabelled,
  (select round(max(extract(epoch from s.updated_at - s.gpt_done))::numeric, 1) from s where s.created_at >= w.since
     and s.status = 'REJECTED' and s.decision is distinct from 'BUY' and s.gpt_done < s.updated_at) as max_new_after_gpt_nonbuy_s
from w order by case w.label when '24h' then 1 when '48h' then 2 else 3 end;
