-- R181 follow-up: decision -> execution lineage invariant audit. SELECT-ONLY.
-- Run against the production project; it writes nothing and takes no locks beyond reads.
--
-- Chain audited:
--   v11_long_regime_signals.id (signal_id)
--   -> gpt_final_entry_reviews (initial FD1 ENTRY review, job_key = decision_id, request_id)
--   -> gpt_final_entry_reviews kind=FD1_FINAL_RECHECK (latest recheck before dispatch)
--   -> v11_long_regime_orders (OPEN_LONG, client_order_id / exchange_order_id)
--   -> exchange_trade_fills (v17_order_id, exchange_trade_id)
--   -> v11_long_regime_positions (signal_id UNIQUE)
--   -> exchange_trade_fills SELL (v17_position_id) = close/settlement
--
-- decision_source (analysis-layer classification; historical rows are NOT rewritten):
--   GPT_VALID        valid answer from the API (BUY / SKIP / ABSTAIN are GPT judgments)
--   PROVIDER_ERROR   HTTP_4xx/5xx from the provider (e.g. HTTP_429 quota) -- not a judgment
--   TIMEOUT          API_TIMEOUT -- not a judgment
--   CONTRACT_INVALID answer received but refused by the local contract (FD_*/RC_*) -- not a judgment
--   LOCAL_ERROR      local preparation failed before any request -- not a judgment
--   PENDING          RUNNING row, no answer yet
with fd1(start) as (values (timestamptz '2026-09-24 05:28:09+00')),  -- first FD1 GPT ENTRY review in production
w(label, since) as (
  values ('24h', now() - interval '24 hours'), ('48h', now() - interval '48 hours'), ('7d', now() - interval '7 days')
), rv as (
  select r.*, coalesce(r.record->>'kind', 'FD1_ENTRY') as kind,
    case
      when r.state <> 'DONE' then 'PENDING'
      when r.valid is true and r.record->'result'->>'origin' = 'OPENAI_API' then 'GPT_VALID'
      when r.error = 'API_TIMEOUT' then 'TIMEOUT'
      when r.error ~ '^HTTP_' then 'PROVIDER_ERROR'
      when r.record->'result'->>'origin' = 'LOCAL_DATA_ERROR' then 'LOCAL_ERROR'
      when r.record->'result'->>'origin' = 'OPENAI_API' then 'CONTRACT_INVALID'
      else 'UNKNOWN'
    end as decision_source,
    to_timestamp(nullif(r.record->>'valid_until_ms', '')::bigint / 1000.0) as valid_until,
    to_timestamp(nullif(r.record->>'expires_at_ms', '')::bigint / 1000.0) as trigger_expires
  from public.gpt_final_entry_reviews r
  where r.purpose = 'PRODUCTION' and r.signal_id is not null
    and coalesce(r.record->>'kind', '') in ('', 'FD1_FINAL_RECHECK')
    and coalesce(r.record->'packet'->>'task', 'ENTRY') = 'ENTRY'
), ini as (   -- the initial entry decision (first ENTRY review of the signal)
  select distinct on (signal_id) * from rv where kind = 'FD1_ENTRY' order by signal_id, created_at, completed_at
), ini_n as (select signal_id, count(*) n from rv where kind = 'FD1_ENTRY' group by 1),
rc_last as (  -- latest FINAL RECHECK of the signal
  select distinct on (signal_id) * from rv where kind = 'FD1_FINAL_RECHECK' order by signal_id, created_at desc
), s as (
  select s.*, i.decision as ini_decision, i.decision_source as ini_source, i.completed_at as ini_done,
    i.valid_until as ini_valid_until, i.job_key as ini_key, i.error as ini_error,
    rc.decision as rc_decision, rc.decision_source as rc_source, rc.completed_at as rc_done,
    public.entry_terminal_class(s.reject_reason, false, false) as reason_class,
    (select count(*) from public.v11_long_regime_positions p where p.signal_id = s.id) as n_pos
  from public.v11_long_regime_signals s
  left join ini i on i.signal_id = s.id::text
  left join rc_last rc on rc.signal_id = s.id::text
), o as (     -- dispatched OPEN_LONG orders with the GPT authority that existed at dispatch time
  select o.*, s.created_at as sig_created, o.created_at >= (select start from fd1) as gpt_era,
    coalesce(nullif(o.request_payload->>'entry_ioc_attempt', '')::int, 1) as attempt_no,
    (select i.decision_source = 'GPT_VALID' and i.decision = 'BUY' and i.completed_at < o.created_at
       from ini i where i.signal_id = o.signal_id::text) as ini_buy_before,
    (select r.decision_source = 'GPT_VALID' and r.decision = 'BUY'
       from rv r where r.signal_id = o.signal_id::text and r.kind = 'FD1_FINAL_RECHECK' and r.completed_at < o.created_at
       order by r.completed_at desc limit 1) as rc_buy_before,  -- NULL = no recheck before dispatch
    (select i.valid_until from ini i where i.signal_id = o.signal_id::text) as ini_valid_until,
    (select i.trigger_expires from ini i where i.signal_id = o.signal_id::text) as trig_exp
  from public.v11_long_regime_orders o join public.v11_long_regime_signals s on s.id = o.signal_id
  where o.intent = 'OPEN_LONG' and (o.exchange_order_id is not null or o.state = 'FILLED')
), rej as (   -- first terminal GPT/lifecycle reject audit per signal (for resurrection checks)
  select (d.details->>'signalId')::uuid sid, min(d.decided_at) at
  from public.v11_long_regime_decisions d
  where d.action = 'ENTRY_REJECT' and d.details ? 'signalId' and d.decided_at > now() - interval '8 days'
    -- CEC0040 is evidence for GPT since the 2026-09-26 "GPT decides" release: its audit row says
    -- ENTRY_REJECT but writes no terminal status. Every other ENTRY_REJECT stage is terminal.
    and coalesce(d.details->>'stage', '') <> 'CEC0040_ENTRY_CONTROL'
  group by 1
), f as (
  select * from public.exchange_trade_fills where exchange = 'binance_futures' and source = 'AUTOMATED'
), pos as (
  select p.*,
    (select coalesce(sum(f.quantity), 0) from f where f.side = 'BUY' and f.v17_position_id = p.id) as buy_qty,
    (select coalesce(sum(f.quantity), 0) from f where f.side = 'SELL' and f.v17_position_id = p.id) as sell_qty,
    (select count(*) from f where f.v17_position_id = p.id) as n_fills
  from public.v11_long_regime_positions p
)
select w.label, x.inv, x.n from w cross join lateral (values
  -- INV-01 GPT != BUY but an execution-capable path exists
  ('INV-01a order dispatched without a prior valid GPT BUY',
    (select count(*) from o where o.created_at >= w.since and o.gpt_era and o.ini_buy_before is not true)),
  ('LEGACY orders before FD1 GPT enforcement (not GPT-governed; informational)',
    (select count(*) from o where o.created_at >= w.since and not o.gpt_era)),
  ('INV-01b order dispatched after a non-BUY FINAL RECHECK',
    (select count(*) from o where o.created_at >= w.since and o.rc_buy_before is false)),
  ('INV-01c signal still NEW/CLAIMED/ORDERED with a final non-BUY initial decision',
    (select count(*) from s where s.created_at >= w.since and s.status in ('NEW','CLAIMED','ORDERED')
       and s.ini_done is not null and s.ini_decision is distinct from 'BUY')),
  ('INV-01d terminal reason contradicts final initial GPT non-BUY (ledger mismatch)',
    (select count(*) from s where s.created_at >= w.since and s.status = 'REJECTED' and s.n_pos = 0
       and s.ini_done is not null and s.ini_decision is distinct from 'BUY' and s.ini_done < s.updated_at
       and s.reason_class <> 'GPT_REJECTED')),
  ('INV-01e terminal reason contradicts final RECHECK non-BUY (ledger mismatch)',
    (select count(*) from s where s.created_at >= w.since and s.status = 'REJECTED' and s.n_pos = 0
       and s.ini_decision = 'BUY' and s.rc_done is not null and s.rc_decision is distinct from 'BUY'
       and s.rc_done < s.updated_at and s.reason_class <> 'GPT_REJECTED')),
  -- INV-02 more than one canonical (initial) decision per signal
  ('INV-02 signals with >1 initial GPT entry decision',
    (select count(*) from ini_n n join public.v11_long_regime_signals s on s.id::text = n.signal_id
       where s.created_at >= w.since and n.n > 1)),
  -- INV-03 more than one executable outcome per signal / per symbol
  ('INV-03a signals with >1 position', (select count(*) from s where s.created_at >= w.since and s.n_pos > 1)),
  ('INV-03b symbols with >1 simultaneously OPEN position',
    (select count(*) from (select symbol from public.v11_long_regime_positions where state = 'OPEN' group by 1 having count(*) > 1) z)),
  -- INV-04 terminal -> active resurrection
  ('INV-04a order dispatched after a terminal ENTRY_REJECT of the same signal',
    (select count(*) from o join rej on rej.sid = o.signal_id where o.created_at >= w.since and o.created_at > rej.at)),
  ('INV-04b REJECTED signal that owns a position',
    (select count(*) from s where s.created_at >= w.since and s.status = 'REJECTED' and s.n_pos > 0)),
  -- INV-05 late / aged answer changed admission
  ('INV-05 order dispatched on an aged initial BUY with no recheck BUY',
    (select count(*) from o where o.created_at >= w.since and o.gpt_era and o.attempt_no = 1
       and o.created_at > o.ini_valid_until and o.rc_buy_before is not true)),
  ('INV-05c IOC retry dispatched outside the 15 s retry authority of attempt 1',
    (select count(*) from o where o.created_at >= w.since and o.gpt_era and o.attempt_no > 1
       and not exists (select 1 from o o1 where o1.signal_id = o.signal_id and o1.attempt_no = 1
         and o.created_at > o1.created_at and o.created_at <= o1.created_at + interval '20 seconds'))),
  ('INV-05b order dispatched after the trigger expiry',
    (select count(*) from o where o.created_at >= w.since and o.gpt_era and o.created_at > o.trig_exp)),
  -- INV-06 duplicate admission
  ('INV-06 signals admitted twice (>1 V17_ENTRY_FILLED audit)',
    (select count(*) from (select d.details->>'signalId' from public.v11_long_regime_decisions d
       where d.decided_at >= w.since and d.action = 'ENTRY_ALLOW' and d.reason = 'V17_ENTRY_FILLED'
       group by 1 having count(*) > 1) z)),
  -- INV-07 fill lineage
  ('INV-07a BUY fill without order lineage',
    (select count(*) from f where f.executed_at >= w.since and f.side = 'BUY' and f.v17_order_id is null)),
  ('INV-07b fill without position lineage',
    (select count(*) from f where f.executed_at >= w.since and f.v17_position_id is null)),
  ('INV-07c BUY fill whose order has no GPT BUY',
    (select count(*) from f join o on o.id = f.v17_order_id where f.executed_at >= w.since and f.side = 'BUY' and o.gpt_era and o.ini_buy_before is not true)),
  ('INV-07d position whose signal has no initial GPT decision',
    (select count(*) from public.v11_long_regime_positions p left join ini i on i.signal_id = p.signal_id::text
       where p.created_at >= w.since and p.created_at >= (select start from fd1) and i.job_key is null)),
  -- INV-08 duplicate exchange fills
  ('INV-08 duplicate exchange_trade_id',
    (select count(*) from (select market, exchange_trade_id from f where f.executed_at >= w.since
       group by 1, 2 having count(*) > 1) z)),
  -- INV-09 quantity attribution
  ('INV-09a closed position: sum(BUY fills) != original_quantity',
    (select count(*) from pos where pos.closed_at >= w.since and pos.state = 'CLOSED'
       and abs(pos.buy_qty - pos.original_quantity) > greatest(1e-9, pos.original_quantity * 1e-8))),
  ('INV-09b closed position: sum(SELL fills) != original_quantity',
    (select count(*) from pos where pos.closed_at >= w.since and pos.state = 'CLOSED'
       and abs(pos.sell_qty - pos.original_quantity) > greatest(1e-9, pos.original_quantity * 1e-8))),
  ('INV-09c fee missing or USDT fee arithmetic mismatch',
    (select count(*) from f where f.executed_at >= w.since and (f.fee_amount is null or f.fee_asset is null
       or (f.fee_asset = 'USDT' and abs(f.fee_amount - coalesce(f.fee_quote_amount, -1)) > 1e-9)))),
  ('INV-09d fill quote_amount != price*quantity',
    (select count(*) from f where f.executed_at >= w.since and abs(f.quote_amount - f.price * f.quantity) > 1e-6 * greatest(1, f.quote_amount))),
  -- INV-10 non-judgment ABSTAIN counted as a GPT judgment by the journal
  ('INV-10 journal counts provider/contract failure as a GPT judgment',
    (select count(*) from public.missed_opportunity_journal j join ini i on i.signal_id = j.signal_id::text
       where j.created_at >= w.since and i.decision_source not in ('GPT_VALID','TIMEOUT','PENDING')
         and j.terminal_class = 'GPT_REJECTED'))
) x(inv, n)
order by x.inv, case w.label when '24h' then 1 when '48h' then 2 else 3 end;
