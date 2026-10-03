-- Admission repair only. Preserve every causal bucket check and existing row;
-- require disabled deterministic authority and replace exactly the reviewed
-- ASCII/two-character restriction with the collector's alphanumeric contract.
do $repair$
declare body text;needle constant text:='^[A-Z0-9]{2,30}USDT$';
begin
 perform 1 from public.deterministic_control where singleton and not enabled
  and version='DETERMINISTIC_DYNAMIC_STATE_1' for share;
 if not found then raise exception 'DISABLED_DETERMINISTIC_AUTHORITY_REQUIRED';end if;
 body:=pg_get_functiondef('public.doa_capture_rpc(text,jsonb)'::regprocedure);
 if strpos(body,needle)=0 or strpos(replace(body,needle,''),needle)>0 then
  raise exception 'EXACT_CAPTURE_ADMISSION_BASELINE_REQUIRED';end if;
 execute replace(body,needle,'^[[:alnum:]]{1,24}USDT$');
end $repair$;
