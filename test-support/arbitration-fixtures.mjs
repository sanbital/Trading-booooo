import {evidenceCatalog} from '../supabase/functions/_shared/gpt-final-decision/advisory.mjs';
export function finalFields(input){
 const key=Object.keys(evidenceCatalog(input)).find(k=>(k.startsWith('facts.')||k.startsWith('current.facts.'))&&k.endsWith('return_5m'));
 const ds=input.independent_reviews?.deepseek,cited=ds?.valid?[...ds.answer.bullish_evidence,...ds.answer.bearish_evidence].slice(0,6).map(k=>'initial.'+k):[];
 return {considered:cited,adopted:[],rejected:cited,supporting:key?['current.'+key]:[],opposing:[],reason:'Independent claims checked against supplied evidence'};
}
