/** In-flight, identical account READ only. No response cache, TTL or order memory.
 * A writer always performs its own fresh read. Original observation times survive. */
export function createAnalysisReadCoalescer(){
 const flights=new Map(),allowed=new Set(['p10_portfolio','v18_open_orders']);
 return async function read(command,send,{kind}={}){
  if(kind!=='ANALYSIS'||!allowed.has(command.action))return send();
  const key=JSON.stringify(command);let flight=flights.get(key);
  if(!flight){flight=Promise.resolve().then(send);flights.set(key,flight);
   const clear=()=>{if(flights.get(key)===flight)flights.delete(key);};flight.then(clear,clear);
  }
  return structuredClone(await flight);
 };
}
