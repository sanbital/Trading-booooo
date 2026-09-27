begin;
-- Append-only protection arbitration audit (AI_PROTECTION_ARBITRATION_1).
-- One row per protection decision on an open position: what the deterministic engine proposed,
-- what was already approved, what the reviewer decided, and what actually became resident.
-- Service-only, insert-only: no update or delete grant exists, so an approved level's history
-- cannot be rewritten. The full model answers (frozen snapshot hash, DeepSeek decision and
-- confidence, GPT arbitration reason with supporting/opposing evidence, model versions) stay in
-- the review journal row referenced by details->>'reviewJobKey'; this table never duplicates them.
create table if not exists public.v11_protection_decisions(
 id bigint generated always as identity primary key,
 revision text not null,
 position_id uuid not null,
 symbol text not null,
 generation text,
 policy_version text not null,
 decided_at timestamptz not null,
 recorded_at timestamptz not null default now(),
 current_price numeric,
 entry_price numeric,
 peak_price numeric,
 current_profit numeric,
 current_drawdown numeric,
 mfe numeric,
 mae numeric,
 mfe_giveback numeric,
 hard_stop numeric,
 hard_reason text,
 candidate_soft_stop numeric,
 candidate_reason text,
 approved_soft_stop numeric,
 approved_reason text,
 approved_source text,
 raised boolean not null default false,
 details jsonb not null default '{}'
);
create index if not exists v11_protection_decisions_position
 on public.v11_protection_decisions(position_id,decided_at desc);
create index if not exists v11_protection_decisions_raised
 on public.v11_protection_decisions(decided_at desc) where raised;

revoke all on table public.v11_protection_decisions from public,anon,authenticated;
grant insert,select on table public.v11_protection_decisions to service_role;

comment on table public.v11_protection_decisions is
'Append-only protection arbitration audit. The deterministic engine proposes candidate_soft_stop; only an AI approval raises approved_soft_stop, which is monotonic and never lowered. Hard safety (hard_stop) is independent of every model. Full model answers live in the review journal row named by details->>''reviewJobKey''.';
commit;
