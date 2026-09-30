create or replace function public.ai_call_settle_receipt(
 p_call_key text,p_owner uuid,p_actual_usd numeric,p_usage jsonb,p_request_id text,p_latency_ms integer,p_http_status integer,p_response jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare out jsonb;l public.ai_call_ledger%rowtype;
begin
 if p_http_status<200 or p_http_status>=300 or jsonb_typeof(p_response)<>'object' or octet_length(p_response::text)>=1000000 then raise exception 'AI_RECEIPT_INVALID';end if;
 out:=public.ai_call_transition(p_call_key,p_owner,'SETTLED',p_usage,p_request_id,p_latency_ms::bigint,null);
 select * into l from public.ai_call_ledger where call_key=p_call_key;
 if l.call_key is null or l.state<>'SETTLED' then raise exception 'AI_RECEIPT_LEDGER_NOT_SETTLED';end if;
 insert into trading_internal.ai_provider_receipts(call_key,parent_key,provider,request_id,http_status,response)
 values(l.call_key,l.parent_key,l.provider,coalesce(p_request_id,l.request_id),p_http_status,p_response) on conflict(call_key) do nothing;
 return out||jsonb_build_object('receipt_stored',true);
end $$;
revoke all on function public.ai_call_settle_receipt(text,uuid,numeric,jsonb,text,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.ai_call_settle_receipt(text,uuid,numeric,jsonb,text,integer,integer,jsonb) to service_role;