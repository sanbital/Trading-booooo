-- Cover the optional terminal order reference used for dispatch reconciliation.
create index leader20_execution_dispatch_order
 on public.leader20_execution_dispatches(order_id)
 where order_id is not null;
