-- Trading-booooo v6.3.3-HEAT — uncertainty haircut becomes tunable and proportional.
--
-- Live rejections showed 19 of 24 candidates failing on NET_EV_NOT_POSITIVE while the
-- barrier arithmetic was sound. The cause was `uncertaintyHaircut`, a flat 0.08 subtracted
-- from a signal edge that runs roughly 0.05-0.12 and is capped at 0.18. It was not
-- discounting the signal, it was deleting it -- and below 0.08 it pushed the conservative
-- probability under the neutral win rate, asserting the signal was actively harmful.
--
-- It is now a fraction, and it lives in the database so that correcting it never again
-- requires a code deploy.

alter table public.trading_settings
  add column if not exists lob_uncertainty_haircut numeric not null default 0.25;

alter table public.trading_settings drop constraint if exists trading_settings_lob_haircut_ck;
alter table public.trading_settings
  add constraint trading_settings_lob_haircut_ck
    check (lob_uncertainty_haircut >= 0 and lob_uncertainty_haircut <= 0.9) not valid;
alter table public.trading_settings validate constraint trading_settings_lob_haircut_ck;
