export const COLLECTOR_BASELINE='930f6e8b54b62bcfd9ecebff1110339ce571e6f7';
export const COLLECTOR_APP='sanbital-doa-capture-20260925';
export function assertCollectorRepairState(s,source,postmaster){
 if(s?.paused!==true||s.enabled!==true||s.generation!==2||s.source!==source||s.gpt_off!==true||s.batch_off!==true||
   s.open_positions!==0||s.unresolved_orders!==0||s.incidents!==0||s.circuit_open!==false||s.protection_health!=='FLAT'||
   s.recovery_complete!==true||s.recovered_postmaster!==s.postmaster||postmaster&&s.postmaster!==postmaster||
   s.capture_enabled!==true||s.capture_production!==true)throw Error('COLLECTOR_REPAIR_SAFETY_GATE');
}
export function collectorReplacement(machine,sha,protocol){
 const cfg=machine?.config;
 if(!/^[a-f0-9]{40}$/.test(sha??'')||machine?.state!=='started'||!machine.instance_id||
   cfg?.image!==`registry.fly.io/${COLLECTOR_APP}:${COLLECTOR_BASELINE}`||cfg.auto_destroy===true||
   cfg.env?.CAPTURE_ENDPOINT!=='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest'||cfg.env?.PROTOCOL_SHA256!==protocol||
   cfg.env?.SOURCE_COMMIT!=null||cfg.services?.length||cfg.mounts?.length)throw Error('COLLECTOR_REPAIR_MACHINE_BASELINE');
 return {...cfg,image:`registry.fly.io/${COLLECTOR_APP}:${sha}`};
}
