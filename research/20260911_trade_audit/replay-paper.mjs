import fs from 'node:fs';
import {observationFrame,replayAccounts} from './paper-accounts.mjs';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node replay-paper.mjs OBSERVATIONS_JSON OUTPUT_JSON');
const protocol=JSON.parse(fs.readFileSync(new URL('./paper-protocol.json',import.meta.url)));
const rows=JSON.parse(fs.readFileSync(input));
if(!Array.isArray(rows))throw Error('EXPECTED_OBSERVATION_ROWS');
// Do not backfill old no-book observations with later quotes or real-account fills.
const eligible=rows.filter(r=>(r.payload??r).source?.market?.version==='V18_PAPER_MARKET_1');
const frames=eligible.map(observationFrame).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
const scenarios=Object.fromEntries(Object.entries(protocol.scenarios).map(([name,settings])=>
  [name,replayAccounts(frames,{...protocol.settings,...settings})]));
const result={protocol,inputRows:rows.length,eligibleRows:eligible.length,missingBookRows:rows.length-eligible.length,
  firstObservation:frames[0]?.at??null,lastObservation:frames.at(-1)?.at??null,scenarios};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({eligibleRows:eligible.length,missingBookRows:rows.length-eligible.length,
  summaries:Object.fromEntries(Object.entries(scenarios).map(([n,r])=>[n,Object.fromEntries(Object.entries(r.accounts).map(([v,a])=>[v,a.summary]))]))},null,2));
