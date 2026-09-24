import {readFileSync} from "node:fs";
import {stats} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows2.json')).filter(r=>r.b&&r.trig?.status==='CLOSED');
const F=['absorption','volumeTails','fresh15over30','btcAnyUp','buyerShareRise','fresh5over15','recentHourLead'];
const MID=Date.parse('2026-09-17T00:00Z');
for(const f of F){const line=[f.padEnd(15)];for(const [lab,fil] of [['all',r=>1],['dev<9/17',r=>r.s5c<MID],['hold>=9/17',r=>r.s5c>=MID]]){
  const X=rows.filter(fil),t=X.filter(r=>r.b.factors[f]===true).map(r=>r.trig),n=X.filter(r=>r.b.factors[f]===false).map(r=>r.trig);
  line.push(`${lab}: T n=${t.length} exp=${stats(t).exp} | F n=${n.length} exp=${stats(n).exp}`);}console.log(line.join('  ||  '));}
console.log('R62 branch',JSON.stringify(stats(rows.filter(r=>r.b.r62===true).map(r=>r.trig))),'rescue',JSON.stringify(stats(rows.filter(r=>r.b.rescue===true).map(r=>r.trig))),'none',JSON.stringify(stats(rows.filter(r=>!r.b.allowed).map(r=>r.trig))));
