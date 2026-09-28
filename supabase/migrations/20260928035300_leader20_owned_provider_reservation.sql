-- A timed-out reservation response must not strand a safe, undispatched attempt.
-- Only the same client nonce can recover RESERVED; DISPATCHED never resumes.
create or replace function public.ai_call_reserve_owned(p_owner uuid,p_key text,p_provider text,p_model text,p_purpose text,
 p_parent text,p_version text,p_reserve numeric) returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;j public.ai_call_ledger%rowtype;
begin
 if p_owner is null then raise exception 'API_CALL_OWNER_REQUIRED'; end if;
 r:=public.ai_call_reserve(p_key,p_provider,p_model,p_purpose,p_parent,p_version,p_reserve);
 if r->>'created'='true' then
  update public.ai_call_ledger set owner=p_owner where call_key=p_key returning * into j;
  return jsonb_build_object('created',true,'row',to_jsonb(j));
 end if;
 if r#>>'{row,owner}'=p_owner::text and r#>>'{row,state}'='RESERVED' then
  return r||jsonb_build_object('created',true,'resumed_reservation',true);
 end if;
 return r;
end $$;
revoke all on function public.ai_call_reserve_owned(uuid,text,text,text,text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.ai_call_reserve_owned(uuid,text,text,text,text,text,text,numeric) to service_role;
