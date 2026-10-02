/** Stable evidence identity across JSONB key ordering and all decision stages. */
function canonical(x){
  if(x===null||['string','boolean'].includes(typeof x))return JSON.stringify(x);
  if(typeof x==='number'){if(!Number.isFinite(x))throw Error('NONFINITE');return JSON.stringify(x);}
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
export async function hash(x){
  const b=new TextEncoder().encode(typeof x==='string'?x:canonical(x));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
