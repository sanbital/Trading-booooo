/** Lossless wire deduplication. References only replace identical JSON values; no sampling. */
export function deduplicateEvidence(value){
 const seen=new Map();
 const visit=(x,path)=>{
  if(!x||typeof x!=='object')return x;
  const encoded=JSON.stringify(x);
  if(encoded.length>=128){if(seen.has(encoded))return {$ref:seen.get(encoded)};seen.set(encoded,path);}
  return Array.isArray(x)?x.map((v,i)=>visit(v,path+'/'+i)):Object.fromEntries(Object.entries(x).map(([k,v])=>[k,visit(v,path+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1'))]));
 };
 return visit(value,'#');
}
export const REFERENCE_NOTE='\nLOSSLESS REFERENCES: {$ref:"#/path"} repeats the exact value at that JSON pointer in this same user input. Resolve references when reading evidence; all 24 ordered buckets and every original measurement are preserved.';
export function compactHoldPayload(payload){
 const copy=structuredClone(payload);copy.input=copy.input.map(x=>x.role==='user'?{...x,content:JSON.stringify(deduplicateEvidence(JSON.parse(x.content)))}:x);
 copy.input[0].content+=REFERENCE_NOTE;return copy;
}
export function technicalFailure(result){return result?.valid!==true&&result?.decision!=='WAIT';}
