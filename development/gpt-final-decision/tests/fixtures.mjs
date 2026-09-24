export const MIN=60000,T=Date.parse('2026-09-20T10:00:00Z');
/** Binance kline rows ending before `at`, rising by `step` per bar, buy share `buy`. */
export function klines(n,interval,at,{p0=1,step=.001,buy=.6,q=10000}={}){
  const out=[];const t0=Math.floor(at/interval)*interval-n*interval;
  for(let i=0;i<n;i++){const t=t0+i*interval,o=p0*(1+step*i),c=o*(1+step);out.push([t,String(o),String(Math.max(o,c)*1.001),String(Math.min(o,c)*.999),String(c),'0',t+interval-1,String(q),0,String(q*buy),String(q*buy),'0']);}
  return out;
}
export function src(at,opt={}){
  return {one:klines(121,MIN,at,opt),five:klines(49,5*MIN,at,opt),btc:klines(61,MIN,at,{step:.0001}),
    oiHist:Array.from({length:13},(_,i)=>({timestamp:Math.floor(at/300000)*300000-(12-i)*300000,sumOpenInterest:1000*(1+.001*i),sumOpenInterestValue:5e6})),
    premium:[[Math.floor(at/MIN)*MIN-MIN,'0','0','0','0.0002','0',Math.floor(at/MIN)*MIN-1]],funding:{rate:.0001},
    book:{bids:[[1.199,2000],[1.198,2000]],asks:[[1.2,2000],[1.201,2000]]},...(opt.src??{})};
}
export function mockApi(wireFor,{model='gpt-5.4-mini-2026-03-17',status=200}={}){
  const calls=[];
  const fetchFn=async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);const input=JSON.parse(body.input[1].content);
    const raw={model,status:'completed',usage:{input_tokens:2000,output_tokens:100,input_tokens_details:{cached_tokens:1500}},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wireFor(input))}]}]};
    return new Response(JSON.stringify(raw),{status,headers:{'x-request-id':'req_1'}});};
  return {fetchFn,calls};
}
