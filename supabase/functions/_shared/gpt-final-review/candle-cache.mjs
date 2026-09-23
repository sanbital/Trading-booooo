/** Per-isolate, public candle-only request coalescing. No credentials or verdicts. */
const caches=new WeakMap();
export function cacheFor(fetchFn){
  if(!caches.has(fetchFn))caches.set(fetchFn,new CandleReadCache());
  return caches.get(fetchFn);
}
export class CandleReadCache {
  constructor({ttlMs=1000,maxEntries=64}={}){this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.entries=new Map();}
  async read(key,load,now=Date.now){
    const at=now();let row=this.entries.get(key);
    if(row&&at-row.startedAt>=0&&((row.value&&at-row.value.receivedAt<=this.ttlMs)||(!row.value&&at-row.startedAt<=2500)))
      return structuredClone(await row.promise);
    if(row)this.entries.delete(key);
    while(this.entries.size>=this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    row={startedAt:at,promise:null,value:null};
    row.promise=Promise.resolve().then(load).then(value=>{
      if(!Number.isSafeInteger(value?.requestedAt)||!Number.isSafeInteger(value?.receivedAt)||value.receivedAt<value.requestedAt||!Array.isArray(value.rows))
        throw Error('CANDLE_CACHE_INPUT_INVALID');
      row.value=structuredClone(value);return row.value;
    }).catch(error=>{if(this.entries.get(key)===row)this.entries.delete(key);throw error;});
    this.entries.set(key,row);return structuredClone(await row.promise);
  }
}
