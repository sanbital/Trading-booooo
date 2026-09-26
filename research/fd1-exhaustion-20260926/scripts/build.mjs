import {readFileSync,writeFileSync} from 'node:fs';
import {computeFacts} from '/home/user/Trading-booooo/supabase/functions/_shared/gpt-final-decision/facts.mjs';
const K=JSON.parse(readFileSync('data/k1.json')),OI=JSON.parse(readFileSync('data/oi.json'));
const J=JSON.parse(readFileSync('data/journal.json')),P=JSON.parse(readFileSync('data/positions.json')),G=JSON.parse(readFileSync('data/gpt.json'));
const MIN=60000;
const idx={};for(const [s,rows] of Object.entries(K)){const m=new Map();rows.forEach((r,i)=>m.set(r[0],i));idx[s]=m;}
const bin=(r,iv=MIN)=>[r[0],String(r[1]),String(r[2]),String(r[3]),String(r[4]),"0",r[0]+iv-1,String(r[5]),0,'0',String(r[6])];
function slice(sym,endT,n){const rows=K[sym],m=idx[sym];if(!rows)return null;const i=m.get(endT);if(i===undefined||i-n+1<0)return null;
  const xs=rows.slice(i-n+1,i+1);for(let k=1;k<xs.length;k++)if(xs[k][0]-xs[k-1][0]!==MIN)return null;return xs;}
function five(xs){const out=[];for(let i=0;i<xs.length;i++){const t=xs[i][0];if(t%(5*MIN))continue;const g=xs.slice(i,i+5);if(g.length<5)break;
  out.push([t,g[0][1],Math.max(...g.map(x=>x[2])),Math.min(...g.map(x=>x[3])),g[4][4],g.reduce((s,x)=>s+x[5],0),g.reduce((s,x)=>s+x[6],0)]);}return out;}
// R5 live exit policy (leader-exit-review.mjs EXIT_REVIEW_R5 + V17 trail/stale), 1m bars, stop checked before the bar's high updates the peak.
export function simR5(entry,bars,{horizon=120}={}){
  let peak=entry,lastHigh=0,stop=entry*(1-.025),mfe=0,mae=0;
  for(let i=0;i<Math.min(bars.length,horizon);i++){const [t,o,h,l,c]=bars[i];
    if(l<=stop){const px=Math.min(o,stop);mae=Math.min(mae,l/entry-1);return {ret:px/entry-1,exitMin:i+1,why:'STOP',mfe,mae};}
    if(h>peak){peak=h;lastHigh=i;}mfe=Math.max(mfe,peak/entry-1);mae=Math.min(mae,l/entry-1);
    const lv=[entry*(1-.025)];if(mfe>=.01||i+1>=10)lv.push(entry*(1-.012));if(mfe>=.02)lv.push(entry+(peak-entry)*.5);if(mfe>=.03)lv.push(peak*(1-.015));
    stop=Math.max(stop,...lv);
    if(i-lastHigh>=45)return {ret:c/entry-1,exitMin:i+1,why:'STALE',mfe,mae};}
  const last=bars[Math.min(bars.length,horizon)-1];return {ret:last[4]/entry-1,exitMin:Math.min(bars.length,horizon),why:'HORIZON',mfe,mae};
}
function fwd(sym,t0,n){const rows=K[sym],i=idx[sym]?.get(t0);if(i===undefined)return null;const xs=rows.slice(i,i+n);return xs.length>=Math.min(n,60)?xs:null;}
const gByS={};for(const g of G){(gByS[g.sid]??=[]).push(g);}
const posBySym={};for(const p of P)if(p.strat==='LEADER_MOMENTUM_V17'&&p.out)(posBySym[p.sym]??=[]).push(p);
const out=[];let miss=0;
for(const c of J){
  const dec=c.trig??c.at, asOf=dec+2000, endT=Math.floor(asOf/MIN)*MIN-MIN;
  const one=slice(c.sym,endT,121),btc=slice('BTCUSDT',endT,61);
  if(!one||!btc){miss++;if(miss<4)console.log("slice",!!one,!!btc,c.sym);continue;}
  const f5=five(slice(c.sym,endT,250)??one).filter(x=>x[0]+5*MIN<=asOf).slice(-49);
  const oiHist=(OI[c.sym]??[]).filter(x=>x[0]<=asOf&&x[0]>asOf-3*3600e3).map(([t,v,u])=>({timestamp:t,sumOpenInterest:v,sumOpenInterestValue:u}));
  let facts;try{facts=computeFacts({one:one.map(r=>bin(r)),five:f5.map(r=>bin(r,5*MIN)),btc:btc.map(r=>bin(r)),oiHist,premium:[],funding:null,book:null,bookMissingReason:'NOT_POINT_IN_TIME_REPLAY'},
    {asOf,referenceClose:c.ref,dayReturn:c.dr,rank:c.rank});}catch(e){miss++;if(miss<4)console.log(e.message);continue;}
  const entryPx=one.at(-1)[4],fw=fwd(c.sym,endT+MIN,130);if(!fw){miss++;continue;}
  const sim=simR5(entryPx,fw);
  const mfe60=Math.max(...fw.slice(0,60).map(x=>x[2]))/entryPx-1,mae60=Math.min(...fw.slice(0,60).map(x=>x[3]))/entryPx-1;
  // same-symbol trade memory: last V17 position of this symbol closed before the decision
  const prev=(posBySym[c.sym]??[]).filter(p=>p.out<dec).sort((a,b)=>b.out-a.out)[0]??null;
  const prevCount=(posBySym[c.sym]??[]).filter(p=>p.in<dec&&p.in>=dec-24*3600e3).length;
  let prevCtx=null;
  if(prev){const since=fwd(c.sym,Math.floor(prev.out/MIN)*MIN,Math.max(1,Math.round((endT-Math.floor(prev.out/MIN)*MIN)/MIN)+1))??[];
    const hiSince=since.length?Math.max(...since.map(x=>x[2])):null;
    prevCtx={min_since_exit:(dec-prev.out)/MIN,pnl:prev.pnl,ret:prev.xp/prev.ep-1,mfe:prev.pk/prev.ep-1,why:prev.why,peak:prev.pk,exit:prev.xp,
      px_vs_peak:entryPx/prev.pk-1,px_vs_exit:entryPx/prev.xp-1,new_high_since_exit:hiSince!==null&&hiSince>prev.pk,hold_min:(prev.out-prev.in)/MIN};}
  const gs=(gByS[c.sid]??[]).sort((a,b)=>a.at-b.at),ge=gs.find(g=>g.kind===''&&(g.task??'ENTRY')==='ENTRY'),rc=gs.filter(g=>g.kind==='FD1_FINAL_RECHECK');
  out.push({sid:c.sid,sym:c.sym,dec,path:c.path??(c.trig?'TRIG':'LEGACY'),rr:c.rr,cec:c.cec,cecp:c.cecp===null?null:Number(c.cecp),b06:c.b06,v30:c.v30,gpt:c.gpt,fgpt:c.fgpt,pos:c.pos,
    v:facts.values,complete:facts.quality.candles_complete,entryPx,sim,mfe60,mae60,prev:prevCtx,prevCount,
    gptFacts:ge?.facts??null,gptAns:ge?.ans??null,gptErr:ge?.err??null,rechecks:rc.map(r=>({d:r.d,trig:r.trig})),notional:c.not});
}
writeFileSync('data/replay.json',JSON.stringify(out));
console.log('built',out.length,'missing',miss);
