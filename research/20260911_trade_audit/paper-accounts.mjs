/** Deterministic sampled-book experiment. No IO, broker or live account writes.
 * All wallets/positions are independent simulated state, starting flat.
 * Funding and intraminute native-stop execution remain UNVERIFIED.
 */
import {VARIANTS,evaluateEntry,evaluateExit} from '../../supabase/functions/_shared/leader-strategy-shadow.mjs';
import {STRATEGY,entryFresh} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
export const MODEL='V18_PAPER_ACCOUNTS_1';
const number=v=>v===null||v===''||v===undefined?NaN:Number(v);
const floor=(v,s)=>Number((Math.floor(v/s+1e-9)*s).toPrecision(14));
const ceil=(v,s)=>Number((Math.ceil(v/s-1e-9)*s).toPrecision(14));
const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
const iso=t=>new Date(t).toISOString();

// Mirrors the current 40+0.25 margin sizing envelope, parameterized for experiments.
export function paperIntent(ask,rule,c){
  const step=number(rule?.step),min=number(rule?.minNotional),tick=number(rule?.tick);
  if(!(step>0&&tick>0&&min>0&&rule.trading===true))throw Error('SYMBOL_RULES_UNAVAILABLE');
  const target=c.marginUsdt*c.leverage;
  let quantity=ceil(target/ask,step);
  if(quantity*ask<target+.12&&(quantity+step)*ask/c.leverage<=c.marginUsdt+.25)quantity=floor(quantity+step,step);
  const limit=Math.max(ask*1.0003,(target+.12)/quantity);
  if(quantity*ask<min||quantity*ask/c.leverage>c.marginUsdt+.25+1e-9||
    quantity*limit/c.leverage>c.marginUsdt+.25+1e-9||(limit/ask-1)*10000>12+1e-8)
    throw Error('SIZING_OR_IOC_GUARD');
  return {quantity,limit,reserve:quantity*limit/c.leverage+Math.max(.10,quantity*limit*c.feeRate),step,tick};
}

export function observationFrame(row){
  const p=row.payload??row,m=p.source?.market;
  const at=Date.parse(m?.observedAt??p.finishedAt??p.asOf);
  return {id:`${p.version}:${row.slot_at??p.asOf}`,at,
    marketComplete:m?.version==='V18_PAPER_MARKET_1',quotes:m?.quotes??[],rules:m?.rules??{},
    signals:p.evaluationState==='EVALUATED'?(p.source?.confirmations??[]).filter(x=>x.feature)
      .map(x=>({id:`${x.feature.symbol}:${x.feature.signal5Close}`,features:x.feature})):[],
    entryDataComplete:p.evaluationState==='EVALUATED',sourceVersion:p.version};
}

export function replayAccounts(frames,settings){
  const c={feeRate:.0005,slippageBps:0,latencyMs:0,maxQuoteAgeMs:90000,maxFrameGapMs:90000,...settings};
  c.entrySlippageBps??=c.slippageBps;c.exitSlippageBps??=c.slippageBps;
  if(!['initialBalance','marginUsdt','leverage','maxSlots'].every(k=>Number.isFinite(c[k])&&c[k]>0)||
    !Number.isInteger(c.maxSlots)||!Number.isInteger(c.leverage)||
    !['feeRate','slippageBps','entrySlippageBps','exitSlippageBps','latencyMs','maxQuoteAgeMs','maxFrameGapMs'].every(k=>Number.isFinite(c[k])&&c[k]>=0)||
    c.feeRate>=.01||Math.max(c.slippageBps,c.entrySlippageBps,c.exitSlippageBps)>=100||c.latencyMs>600000)throw Error('INVALID_EXPERIMENT_CONFIG');
  const accounts=Object.fromEntries(Object.keys(VARIANTS).map(variant=>[variant,{variant,wallet:c.initialBalance,
    positions:[],closed:[],pendingEntries:[],seenSignals:new Set(),opportunityIds:new Set(),events:[],curve:[],liquidity:new Map(),
    peakEquity:c.initialBalance,maxObservedDrawdown:0,fees:0,turnover:0,opportunities:0,incompleteFrames:0}]));
  const seen=new Map();let lastAt=null,uniqueFrames=0;
  for(const frame of frames){
    if(!frame.id||!Number.isSafeInteger(frame.at)||!Array.isArray(frame.quotes)||!Array.isArray(frame.signals))throw Error('INVALID_FRAME');
    const serialized=JSON.stringify(frame);
    if(seen.has(frame.id)){if(seen.get(frame.id)!==serialized)throw Error('CONFLICTING_FRAME');continue;}
    if(lastAt!==null&&frame.at<=lastAt)throw Error('OUT_OF_ORDER_FRAME');
    seen.set(frame.id,serialized);uniqueFrames++;
    const gap=lastAt!==null&&frame.at-lastAt>c.maxFrameGapMs;
    const quotes=new Map();
    for(const raw of frame.quotes){
      if(quotes.has(raw.symbol))throw Error('DUPLICATE_QUOTE');
      const q={...raw,bid:number(raw.bid),ask:number(raw.ask),bidQty:number(raw.bidQty),askQty:number(raw.askQty),at:number(raw.at)};
      if(!raw.symbol||![q.bid,q.ask,q.bidQty,q.askQty,q.at].every(Number.isFinite)||
        q.bid<=0||q.ask<q.bid||q.bidQty<0||q.askQty<0||q.at>frame.at||frame.at-q.at>c.maxQuoteAgeMs)continue;
      quotes.set(q.symbol,q);
    }
    for(const a of Object.values(accounts)){
      const event=(type,data={})=>a.events.push({at:frame.at,type,...data});
      const depth=q=>{
        const key=JSON.stringify([q.at,q.bid,q.ask,q.bidQty,q.askQty]);
        if(a.liquidity.get(q.symbol)?.key!==key)a.liquidity.set(q.symbol,{key,bid:q.bidQty,ask:q.askQty});
        return a.liquidity.get(q.symbol);
      };
      const valuation=()=>{
        if(a.positions.some(p=>!quotes.has(p.symbol)))return null;
        return a.wallet+sum(a.positions,p=>p.quantity*(quotes.get(p.symbol).bid-p.entryPrice));
      };
      const free=()=>{
        const equity=valuation();if(equity===null)return null;
        return Math.min(a.wallet,equity)-sum(a.positions,p=>p.quantity*p.entryPrice/c.leverage)-sum(a.pendingEntries,p=>p.reserve);
      };
      if(!frame.marketComplete||!frame.entryDataComplete||gap)a.incompleteFrames++;
      if(gap)event('OBSERVATION_GAP');
      // Management is independent of entry eligibility and of other positions' missing quotes.
      for(const p of [...a.positions]){
        const q=quotes.get(p.symbol);
        if(!q){event('POSITION_QUOTE_UNAVAILABLE',{symbol:p.symbol});a.incompleteFrames++;continue;}
        const d=evaluateExit({...p,entryFee:p.entryFee*p.quantity/p.originalQuantity},q.bid,frame.at,a.variant);
        p.peakPrice=d.peakPrice;p.lastHighAt=d.lastHighAt;p.stopPrice=d.stopPrice;
        if(d.action==='CLOSE'&&!p.pendingExit){p.pendingExit={due:frame.at+c.latencyMs,signalAt:frame.at,reason:d.reason};event('EXIT_SIGNAL',{symbol:p.symbol,reason:d.reason});}
        if(!p.pendingExit||p.pendingExit.due>frame.at)continue;
        const liquidity=depth(q),qty=floor(Math.min(p.quantity,liquidity.bid),p.step);
        if(qty<=0){event('EXIT_NO_LIQUIDITY',{symbol:p.symbol});continue;}
        const price=q.bid*(1-c.exitSlippageBps/10000),fee=qty*price*c.feeRate,gross=qty*(price-p.entryPrice);
        a.wallet+=gross-fee;a.fees+=fee;a.turnover+=qty*price;liquidity.bid-=qty;
        p.quantity=Number((p.quantity-qty).toPrecision(14));p.net+=gross-fee;p.exitFees+=fee;
        p.exitFills.push({at:frame.at,quantity:qty,price,fee,signalDelayMs:frame.at-p.pendingExit.signalAt});
        event('EXIT_FILL',{symbol:p.symbol,quantity:qty,price,remaining:p.quantity});
        if(p.quantity<=Math.max(1e-10,p.originalQuantity*1e-9)){
          p.quantity=0;p.closedAt=frame.at;p.reason=p.pendingExit.reason;
          a.closed.push(p);a.positions=a.positions.filter(x=>x!==p);
        }
      }
      const fillEntry=intent=>{
        const q=quotes.get(intent.symbol),reason=q?entryFresh(intent.features,frame.at,intent.limit):'ENTRY_QUOTE_UNAVAILABLE';
        if(reason||q.ask*(1+c.entrySlippageBps/10000)>intent.limit){event('ENTRY_EXPIRED',{symbol:intent.symbol,reason:reason??'IOC_LIMIT'});return;}
        const liquidity=depth(q),quantity=floor(Math.min(intent.quantity,liquidity.ask),intent.step);
        if(quantity<=0){event('ENTRY_NO_LIQUIDITY',{symbol:intent.symbol});return;}
        const price=q.ask*(1+c.entrySlippageBps/10000),fee=quantity*price*c.feeRate;
        const available=free();
        if(available===null||available+1e-9<quantity*price/c.leverage+fee){event('ENTRY_FUNDS_CHANGED',{symbol:intent.symbol});return;}
        liquidity.ask-=quantity;a.wallet-=fee;a.fees+=fee;a.turnover+=quantity*price;
        const p={id:`paper:${a.variant}:${intent.id}`,symbol:intent.symbol,entryAt:frame.at,entryPrice:price,
          originalQuantity:quantity,quantity,entryFee:fee,exitFees:0,net:-fee,peakPrice:price,lastHighAt:frame.at,
          stopPrice:price*(1-intent.features.stopPct),step:intent.step,priceTick:intent.tick,
          policy:intent.features.exitPolicy??{},exitFills:[]};
        a.positions.push(p);event('ENTRY_FILL',{symbol:p.symbol,quantity,requested:intent.quantity,price});
      };
      // Reservation remains until its simulated IOC is resolved. No duplicate signal retries.
      for(const intent of [...a.pendingEntries])if(intent.due<=frame.at){
        a.pendingEntries=a.pendingEntries.filter(x=>x!==intent);fillEntry(intent);
      }
      if(frame.marketComplete&&frame.entryDataComplete){
        const signals=[...frame.signals].sort((a,b)=>b.features.signal5Close-a.features.signal5Close||a.features.rank-b.features.rank||a.id.localeCompare(b.id));
        for(const signal of signals){
          if(!signal.id||!signal.features?.symbol)throw Error('INVALID_SIGNAL');
          if(a.seenSignals.has(signal.id))continue;
          if(!a.opportunityIds.has(signal.id)){a.opportunityIds.add(signal.id);a.opportunities++;}
          const f=signal.features,q=quotes.get(f.symbol);
          if(!(f.stopPct>0&&f.stopPct<1)){a.seenSignals.add(signal.id);event('SIGNAL_INVALID',{symbol:f.symbol});continue;}
          const history=a.closed.map(p=>({id:p.id,symbol:p.symbol,state:'CLOSED',closed_at:iso(p.closedAt),updated_at:iso(p.closedAt),
            realized_pnl_usdt:p.net,exit_reason:p.reason,metadata:{executionMode:STRATEGY}}));
          const decision=evaluateEntry({symbol:f.symbol,features:f,asOf:frame.at,history,variant:a.variant});
          if(decision.verdict!=='NO_ADDITIONAL_FILTER'){a.seenSignals.add(signal.id);event('CANDIDATE_FILTER',{symbol:f.symbol,verdict:decision.verdict,reasons:decision.reasons});continue;}
          if(a.positions.some(p=>p.symbol===f.symbol)||a.pendingEntries.some(p=>p.symbol===f.symbol)){event('SYMBOL_OCCUPIED',{symbol:f.symbol});continue;}
          if(a.positions.length+a.pendingEntries.length>=c.maxSlots){event('SLOTS_FULL',{symbol:f.symbol});continue;}
          if(!q){event('ENTRY_QUOTE_UNAVAILABLE',{symbol:f.symbol});continue;}
          if((q.ask/q.bid-1)*10000>25){event('ENTRY_SPREAD',{symbol:f.symbol});continue;}
          let intent;try{intent={...paperIntent(q.ask,frame.rules[f.symbol],c),...signal,symbol:f.symbol,due:frame.at+c.latencyMs};}
          catch(e){event('ENTRY_SIZING_REJECTED',{symbol:f.symbol,reason:e.message});continue;}
          const fresh=entryFresh(f,frame.at,intent.limit);if(fresh){event('ENTRY_FRESHNESS',{symbol:f.symbol,reason:fresh});continue;}
          const available=free();if(available===null||available<intent.reserve){event('FUNDS_UNAVAILABLE',{symbol:f.symbol});continue;}
          event('ENTRY_INTENT',{symbol:f.symbol,quantity:intent.quantity,limit:intent.limit});
          a.seenSignals.add(signal.id);
          if(c.latencyMs===0)fillEntry(intent);else a.pendingEntries.push(intent);
          // Current executor stops after a dispatched order, including a zero fill.
          break;
        }
      }
      const equity=valuation();
      if(equity!==null){a.peakEquity=Math.max(a.peakEquity,equity);a.maxObservedDrawdown=Math.max(a.maxObservedDrawdown,a.peakEquity-equity);}
      a.curve.push({at:frame.at,wallet:a.wallet,equity,free:free(),positions:a.positions.length,
        reserved:sum(a.pendingEntries,p=>p.reserve),notional:equity===null?null:sum(a.positions,p=>p.quantity*quotes.get(p.symbol).bid)});
    }
    lastAt=frame.at;
  }
  for(const a of Object.values(accounts)){
    const wins=a.closed.filter(p=>p.net>0),losses=a.closed.filter(p=>p.net<0),last=a.curve.at(-1);
    a.summary={closed:a.closed.length,open:a.positions.length,pendingEntries:a.pendingEntries.length,opportunities:a.opportunities,
      closedNet:sum(a.closed,p=>p.net),markedNet:last?.equity===null||!last?null:last.equity-c.initialBalance,
      winRate:a.closed.length?wins.length/a.closed.length:null,expectancy:a.closed.length?sum(a.closed,p=>p.net)/a.closed.length:null,
      profitFactor:losses.length?sum(wins,p=>p.net)/-sum(losses,p=>p.net):null,
      worst:a.closed.length?Math.min(...a.closed.map(p=>p.net)):null,
      maxObservedDrawdown:a.maxObservedDrawdown,completeDrawdown:a.incompleteFrames?null:a.maxObservedDrawdown,
      fees:a.fees,turnover:a.turnover,incompleteFrames:a.incompleteFrames};
    delete a.seenSignals;delete a.opportunityIds;delete a.liquidity;
  }
  return {model:MODEL,executionEnabled:false,livePromotion:false,fundingVerified:false,settings:c,uniqueFrames,accounts,
    limitations:['Sampled L1 depth is an execution assumption, not historical fills or full depth',
      'No intraminute native stop, liquidation, funding or exchange queue simulation',
      'Starts flat with explicit hypothetical cash; does not inherit real positions or their stop history',
      'Actual executor sizing, signal dispatch timing and account availability still require fidelity validation']};
}
