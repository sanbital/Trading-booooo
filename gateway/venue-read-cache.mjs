// Only reference data and explicit, short REST recovery reads belong here.
// Never refresh timestamps on reuse; callers can still enforce the original age.
export function createVenueReadCache({now=Date.now}={}) {
 const values=new Map(),flights=new Map();let hits=0,misses=0;
 return {
  async read(key,ttl,work){
   const value=values.get(key);if(value&&now()-value.at<ttl){hits++;return structuredClone(value.data);}
   let flight=flights.get(key);
   if(!flight){misses++;const generation=value?.generation??0;
    flight=Promise.resolve().then(work).then(data=>{if((values.get(key)?.generation??0)!==generation)throw Object.assign(Error('VENUE_READ_INVALIDATED'),{status:503,code:'VENUE_READ_INVALIDATED'});values.set(key,{at:now(),data,generation});return data;});
    flights.set(key,flight);const clear=()=>{if(flights.get(key)===flight)flights.delete(key);};flight.then(clear,clear);
   }else hits++;
   return structuredClone(await flight);
  },
  invalidate(key){const old=values.get(key);values.set(key,{at:-Infinity,data:null,generation:(old?.generation??0)+1});flights.delete(key);},
  invalidatePrefix(prefix){for(const key of new Set([...values.keys(),...flights.keys()]))if(key.startsWith(prefix))this.invalidate(key);},
  snapshot(){return {hits,misses,in_flight:flights.size};},
 };
}
