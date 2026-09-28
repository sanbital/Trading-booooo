-- Remove only the private synthetic fixture created by this release audit.
-- No production trading table, scheduler, order, capture or credential belongs here.
drop schema if exists leader20_release_audit cascade;
