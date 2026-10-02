import {AsyncLocalStorage} from 'node:async_hooks';
// Request-local capabilities. Child tasks cannot inherit authority after the parent
// critical section ends, and an analysis task can never see a parallel writer owner.
const contexts=new AsyncLocalStorage();
export function assertActiveExecutionRequest(db){
 const c=contexts.getStore();if(c?.db===db){if(!c.active)throw Error('EXECUTION_REQUEST_FINISHED');c.signal?.throwIfAborted();}return c?.db===db?c:null;
}
export function contextualState(key,fallback=new WeakMap()){
 return {get(db){const c=contexts.getStore();return c?.db===db?(c.active?c[key]:null):fallback.get(db);},
  set(db,value){const c=assertActiveExecutionRequest(db);if(c)c[key]=value;else fallback.set(db,value);return this;},
  delete(db){const c=assertActiveExecutionRequest(db);if(c)delete c[key];else fallback.delete(db);}};
}
export function executionContextHeaders(db){
 const c=assertActiveExecutionRequest(db);if(!c)return {};
 if(c.kind==='WRITER')return {'x-v18-execution-owner':c.owner};
 if(c.kind==='ANALYSIS'&&c.owner)return {'x-v18-analysis-owner':c.owner,'x-v18-analysis-fence':String(c.fence),
  ...(c.claim?.signalId?{'x-v18-analysis-dispatch':c.claim.signalId}:{})};
 return {};
}
export function currentExecutionContext(db){
 const c=contexts.getStore();return c?.db===db&&c.active===true?c:null;
}
export function currentAccountOwner(db){const c=currentExecutionContext(db);return c?.kind==='WRITER'?c.owner:null;}
export function contextualOwners(fallback=new WeakMap()){
 return {get(db){const c=contexts.getStore();return c?.db===db?currentAccountOwner(db):fallback.get(db);},
  set:(db,owner)=>fallback.set(db,owner),delete:db=>fallback.delete(db),has(db){const c=contexts.getStore();return c?.db===db?!!currentAccountOwner(db):fallback.has(db);}};
}
export async function withWriterContext(db,owner,operation,{signal}={}){
 if(!owner)throw Error('WRITER_OWNER_REQUIRED');
 const inherited=assertActiveExecutionRequest(db);
 if(inherited?.kind==='WRITER'){
  if(inherited.owner!==owner)throw Error('NESTED_WRITER_OWNER_MISMATCH');
  inherited.signal?.throwIfAborted();return operation(inherited);
 }
 const context={budget:inherited?.budget,claim:inherited?.claim,db,owner,kind:'WRITER',active:true,signal:inherited?.signal&&signal?AbortSignal.any([inherited.signal,signal]):signal??inherited?.signal};
 try{return await contexts.run(context,()=>{context.signal?.throwIfAborted();return operation(context);});}
 finally{context.active=false;}
}
export async function withAnalysisContext(db,operation,{owner=null,signal,capabilities={}}={}){
 assertActiveExecutionRequest(db);if(currentAccountOwner(db))throw Error('ANALYSIS_INSIDE_ACCOUNT_WRITER_FORBIDDEN');
 const context={...capabilities,db,owner,kind:'ANALYSIS',active:true,signal};
 try{return await contexts.run(context,()=>{context.signal?.throwIfAborted();return operation(context);});}
 finally{context.active=false;}
}
export function assertAccountWriterContext(db){
 const c=currentExecutionContext(db);if(c?.kind!=='WRITER'||!c.owner)throw Error('ACCOUNT_WRITER_CONTEXT_REQUIRED');
 c.signal?.throwIfAborted();return c;
}
export function assertAnalysisContext(db){
 const c=currentExecutionContext(db);if(c?.kind!=='ANALYSIS')throw Error('ANALYSIS_CONTEXT_REQUIRED');
 c.signal?.throwIfAborted();return c;
}

export async function withLeaseCleanup(db,operation){
 // Only owner-scoped release RPCs are permitted by the host fetch boundary.
 const context={db,owner:null,kind:'CLEANUP',active:true};
 try{return await contexts.run(context,operation);}finally{context.active=false;}
}
