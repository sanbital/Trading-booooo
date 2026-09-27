import {evidenceCatalog,advisoryEvidenceIds} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
export function advisoryWire(input,answer){
 const ids=advisoryEvidenceIds({packet:{task:input.t},market_input:input});
 const reverse=Object.fromEntries(Object.entries(ids).map(([id,path])=>[path,id]));
 const {bullish_evidence,bearish_evidence,...wire}=answer;
 return {...wire,bullish_evidence_ids:bullish_evidence.map(p=>reverse[p]??'E999'),bearish_evidence_ids:bearish_evidence.map(p=>reverse[p]??'E999')};
}
export function finalFields(input){
 const key=Object.keys(evidenceCatalog(input)).find(k=>(k.startsWith('facts.')||k.startsWith('current.facts.'))&&k.endsWith('return_5m'));
 const ds=input.independent_reviews?.deepseek,cited=ds?.valid?[...ds.answer.bullish_evidence,...ds.answer.bearish_evidence].slice(0,6).map(k=>'initial.'+k):[];
 return {considered:cited,adopted:[],rejected:cited,supporting:key?['current.'+key]:[],opposing:[],reason:'Independent claims checked against supplied evidence'};
}
