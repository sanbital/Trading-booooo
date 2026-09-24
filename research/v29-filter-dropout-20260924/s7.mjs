import {readFileSync} from "node:fs";
const rows=JSON.parse(readFileSync('data/rows2.json'));
const iso=t=>t?new Date(t).toISOString().slice(5,16):null;
const nil=rows.filter(r=>r.symbol==='NILUSDT'&&r.s5c>Date.parse('2026-09-23T00:00Z'));
for(const r of nil)console.log(iso(r.s5c),r.reason.padEnd(22),'day',(r.dayReturn*100).toFixed(1),'r60',(r.r60*100).toFixed(1),'sim',r.simSetup,'trig',iso(r.triggerAt),'b',r.b?.reason??'',r.prodCec??'', 'trigNet',r.trig?.net?.toFixed(2)??'', 'immNet',r.immediate?.net?.toFixed(2),'chaseNet',r.chase?.net?.toFixed(2)??'','fwd max60',(r.fwd.max60*100)?.toFixed(1),'ret60',(r.fwd.ret60*100)?.toFixed(1),'ret240',r.fwd.ret240!=null?(r.fwd.ret240*100).toFixed(1):'');
