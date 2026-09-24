import {readFileSync} from "node:fs";
import {range,MIN,stats} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows2.json')).filter(r=>r.trig?.status==='CLOSED');
for(const r of rows){const {out}=range(r.symbol,r.triggerAt-60*MIN,r.triggerAt);if(out.length<16){r.x=null;continue}
 const last=out.at(-1),h15=Math.max(...out.slice(-15).map(b=>b[2])),c=out.map(b=>b[4]);
 const q=out.map(b=>b[5]),tb=out.map(b=>b[6]),sum=a=>a.reduce((x,y)=>x+y,0);
 r.x={dh15:last[4]/h15-1,r5:last[4]/c.at(-6)-1,lcc:last[4]/c.at(-2)-1,vr3:sum(q.slice(-3))/Math.max(1e-9,sum(q.slice(-6,-3))),tbr3:sum(tb.slice(-3))/Math.max(1e-9,sum(q.slice(-3))),dsma20:last[4]/(sum(c.slice(-20))/20)-1,dref:last[4]/r.ref-1};}
const X=rows.filter(r=>r.x);
function q5(k){const v=X.map(r=>r.x[k]).sort((a,b)=>a-b);const cut=[.2,.4,.6,.8].map(p=>v[Math.floor(p*v.length)]);
 const b=[[],[],[],[],[]];for(const r of X){let i=0;while(i<4&&r.x[k]>cut[i])i++;b[i].push({...r.trig,symbol:r.symbol});}
 console.log(k.padEnd(7),b.map((t,i)=>`Q${i+1}[${i?cut[i-1].toFixed(4):'-inf'}..] n=${t.length} exp=${stats(t).exp} win=${stats(t).win}`).join(' | '));}
for(const k of ['dh15','r5','lcc','vr3','tbr3','dsma20','dref'])q5(k);
