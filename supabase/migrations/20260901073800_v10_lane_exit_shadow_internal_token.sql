insert into public.edge_internal_tokens(name,token,created_at,rotated_at)
values('v10-lane-exit-shadow',encode(gen_random_bytes(32),'hex'),clock_timestamp(),clock_timestamp())
on conflict(name) do nothing;
