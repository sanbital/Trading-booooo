-- v6.12.1 reservation-aligned revalidation budget.
--
-- The position reservation holds the full slot until maker-order settlement, while the order
-- itself is constrained by evidence sizing and the KRW 40,000 executable minimum. A 0.25%
-- daily lane budget was therefore smaller than one valid reserved slot and made the lane
-- unreachable. At 0.40%, one bounded revalidation can run at a time; after a realized loss the
-- same daily budget stops repetition. The global KST -30% circuit is unchanged.

alter table public.trading_settings
  alter column lob_revalidation_daily_loss_pct set default 0.40;

update public.trading_settings
   set lob_revalidation_daily_loss_pct = 0.40,
       updated_at = now()
 where id = 1
   and lob_revalidation_daily_loss_pct < 0.40;

comment on column public.trading_settings.lob_revalidation_daily_loss_pct is
  'Percent of managed quote capital reserved for the fresh post-v6.12.1 adverse-edge revalidation lane. One concurrent lane position; realized loss consumes the same-day budget.';
