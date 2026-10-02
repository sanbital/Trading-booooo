// Simultaneous reference-data callers share a single HTTP request. Nothing is cached
// after completion; no order mutation, receipt or authority can enter this helper.
export function createInFlightRead(){const flights=new Map();return async(key,read)=>{
 let flight=flights.get(key);if(!flight){flight=Promise.resolve().then(read);flights.set(key,flight);
  const clear=()=>{if(flights.get(key)===flight)flights.delete(key);};flight.then(clear,clear);
 }return structuredClone(await flight);
};}
