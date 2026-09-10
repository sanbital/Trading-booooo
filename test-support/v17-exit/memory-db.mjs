/** Deterministic row store for exercising the real executor paths without IO. */
export function memoryDb(initial={}) {
 const tables=structuredClone(initial),writes=[];
 const field=(row,key)=>key.includes('->>')?row[key.split('->>')[0]]?.[key.split('->>')[1]]:row[key];
 return {tables,writes,from(table){
  const predicates=[];let operation='select',patch=null,maximum=Infinity,sort=null;
  const rows=()=>tables[table]??(tables[table]=[]);
  function execute(single=false){
   let selected=rows().filter(r=>predicates.every(p=>p(r)));
   if(sort)selected.sort((a,b)=>sort.asc?String(field(a,sort.key)).localeCompare(String(field(b,sort.key))):String(field(b,sort.key)).localeCompare(String(field(a,sort.key))));
   selected=selected.slice(0,maximum);
   if(operation==='insert'){
    const added=(Array.isArray(patch)?patch:[patch]).map(p=>({id:crypto.randomUUID(),updated_at:new Date().toISOString(),...structuredClone(p)}));
    rows().push(...added);selected=added;writes.push({table,operation,patch:structuredClone(patch)});
   }else if(operation==='update')for(const row of selected){Object.assign(row,structuredClone(patch));writes.push({table,operation,patch:structuredClone(patch)});}
   return {data:structuredClone(single?(selected[0]??null):selected),error:null};
  }
  const b={select:()=>b,eq(k,v){predicates.push(r=>field(r,k)===v);return b;},
   in(k,vs){predicates.push(r=>vs.includes(field(r,k)));return b;},
   gte(k,v){predicates.push(r=>field(r,k)>=v);return b;},
   or(expr){
    if(expr.includes('last_exit_at.')){const at=expr.split('.lt.')[1];predicates.push(r=>r.last_exit_at==null||r.last_exit_at<at);}
    else {const keys=expr.split(',').map(x=>x.split('.eq.')[0]);predicates.push(r=>keys.some(k=>field(r,k)===true));}
    return b;
   },
   order(k,opt={}){sort={key:k,asc:opt.ascending!==false};return b;},
   limit(n){maximum=n;return b;},
   update(p){operation='update';patch=p;return b;},insert(p){operation='insert';patch=p;return b;},
   single:async()=>execute(true),maybeSingle:async()=>execute(true),
   then(resolve,reject){return Promise.resolve().then(()=>execute()).then(resolve,reject);}};
  return b;
 }};
}
