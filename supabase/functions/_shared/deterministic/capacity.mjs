/** Capacity accounting; current live slot geometry is preserved. */
export const ENTRY_CAPACITY_VERSION='ENTRY_CAPACITY_1';
export const UNUSED_SLOT_REASON=Object.freeze({
  NO_DETERMINISTIC_BUY:'NO_DETERMINISTIC_BUY',
  INSUFFICIENT_MARGIN:'INSUFFICIENT_MARGIN',
  MAX_SLOTS_REACHED:'MAX_SLOTS_REACHED',
  EXECUTION_SAFETY_REJECT:'EXECUTION_SAFETY_REJECT',
  ACCOUNT_SAFETY_BLOCK:'ACCOUNT_SAFETY_BLOCK',
  PENDING_CAPITAL_RESERVED:'PENDING_CAPITAL_RESERVED'});
const R=UNUSED_SLOT_REASON;
/** Refusals that describe the ACCOUNT: the run stops on them and every fundable slot left
 * takes that reason. Anything else is about one symbol and the loop moves on. */
export const ACCOUNT_SCOPED_REASONS=Object.freeze([R.INSUFFICIENT_MARGIN,R.MAX_SLOTS_REACHED,R.PENDING_CAPITAL_RESERVED,R.ACCOUNT_SAFETY_BLOCK]);
const PENDING_STATES=new Set(['PLANNED','DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED']);
const EPS=1e-9;
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:NaN;};
const upper=v=>String(v??'').trim().toUpperCase();
const size=p=>Math.abs(num(p?.quantity??p?.positionAmt??p?.position_amount));
const positive=v=>Number.isFinite(v)&&v>0?v:0;

/** The most one slot can take from free margin (see header). */
export function slotCostUsdt({maxOrderMarginUsdt,leverage,takerFeeRate,iocMaxBps}={}){
  const m=num(maxOrderMarginUsdt),lev=num(leverage),fee=num(takerFeeRate),cap=num(iocMaxBps);
  if(!(m>0&&lev>0&&fee>=0&&cap>=0))throw Error('ENTRY_CAPACITY_SLOT_COST_INVALID');
  return m*(1+lev*(fee+cap/10_000));
}

/** One fill this run made, as the capacity ledger needs it. `marginUsdt` is the ACTUAL margin
 * of what filled (a partial fill books its partial margin, never the slot target). `at` is when
 * the exchange answered the (last) order, so an account snapshot captured after it is known to
 * contain the fill; `fallbackAt` (the booking time, later than the fill) is used only without
 * that evidence, which can only make the snapshot side count the fill twice, never miss it. */
export function ledgerEntry(entry,fallbackAt){
  const answered=num(entry?.entryFinality?.respondedAt);
  return {symbol:upper(entry?.symbol),positionId:entry?.positionId??null,marginUsdt:positive(num(entry?.sizedMarginUsdt)),
    at:Number.isSafeInteger(answered)?answered:fallbackAt};
}

/**
 * @param maxSlots operator account-wide slot limit (MAX_SLOTS)
 * @param slotCost slotCostUsdt(...)
 * @param cashBufferUsdt held once for the account (ENTRY_CASH_BUFFER_USDT)
 * @param livePositions exchange positions (p10_portfolio.positions)
 * @param liveAvailableUsdt exchange available margin (p10_portfolio.available_quote)
 * @param dbPositions v11_long_regime_positions rows in state OPEN
 * @param orders v11_long_regime_orders rows the ops reader returns
 * @param quarantinedOrderIds orders a SYMBOL_QUARANTINE already owns (they do not hold the account)
 * @param snapshot {availableUsdt, capturedAtMs} of trading_account_snapshots, or null
 * @param ledger this run's fills (ledgerEntry)
 */
export function entryCapacity({maxSlots,slotCost,cashBufferUsdt,livePositions=[],liveAvailableUsdt,dbPositions=[],
  orders=[],quarantinedOrderIds=[],snapshot=null,ledger=[]}={}){
  const cost=num(slotCost),buffer=num(cashBufferUsdt);
  if(!Number.isSafeInteger(maxSlots)||maxSlots<1||!(cost>0)||!(buffer>=0))throw Error('ENTRY_CAPACITY_CONFIG_INVALID');
  const live=new Set(livePositions.filter(p=>size(p)>1e-12).map(p=>upper(p?.symbol??p?.market)).filter(Boolean));
  const open=new Set(dbPositions.filter(p=>p?.state==null||p.state==='OPEN').map(p=>upper(p?.symbol)).filter(Boolean));
  const quarantined=new Set(quarantinedOrderIds.map(String));
  const exposurePending=orders.filter(o=>PENDING_STATES.has(o?.state)&&o?.response_payload?.v18ExposureFinal!==true);
  const holds=exposurePending.filter(o=>!quarantined.has(String(o?.id)));
  const pendingEntries=exposurePending.filter(o=>upper(o?.intent)==='OPEN_LONG');
  const booked=ledger.filter(x=>upper(x?.symbol));
  const used=new Set([...live,...open,...pendingEntries.map(o=>upper(o?.symbol)).filter(Boolean),...booked.map(x=>upper(x.symbol))]);
  const slotRoom=Math.max(0,maxSlots-used.size);
  // Free margin, never above what the account can prove. A ledger fill the live view does not
  // show yet is not in the live figure either; a fill after the snapshot is not in the snapshot.
  const liveAvailable=num(liveAvailableUsdt);
  const unseenLive=booked.filter(x=>!live.has(upper(x.symbol))).reduce((a,x)=>a+positive(num(x.marginUsdt)),0);
  let freeMargin=liveAvailable-unseenLive,snapshotAvailable=null;
  if(snapshot){
    const s=num(snapshot.availableUsdt),at=num(snapshot.capturedAtMs);
    if(Number.isFinite(s)&&Number.isFinite(at)){
      snapshotAvailable=s-booked.filter(x=>!(num(x.at)<at)).reduce((a,x)=>a+positive(num(x.marginUsdt)),0);
      freeMargin=Math.min(freeMargin,snapshotAvailable);
    }
  }
  const reservedPendingUsdt=pendingEntries.length*cost;
  const slotsFor=m=>Number.isFinite(m)?Math.max(0,Math.floor((m-buffer+EPS)/cost)):0;
  const marginSlotsGross=slotsFor(freeMargin),marginSlots=slotsFor(freeMargin-reservedPendingUsdt);
  const capacity=holds.length||!Number.isFinite(liveAvailable)?0:Math.min(slotRoom,marginSlots);
  let reason=null,detail=null;
  if(capacity<1){
    if(!Number.isFinite(liveAvailable)){reason=R.ACCOUNT_SAFETY_BLOCK;detail='AVAILABLE_BALANCE_UNREADABLE';}
    else if(holds.length){reason=R.PENDING_CAPITAL_RESERVED;detail=`PENDING_ORDER_IDENTITY:${holds.length}`;}
    else if(slotRoom<1){reason=R.MAX_SLOTS_REACHED;detail=`${used.size}/${maxSlots}`;}
    else if(marginSlotsGross>=1){reason=R.PENDING_CAPITAL_RESERVED;detail=`PENDING_ENTRY_MARGIN:${pendingEntries.length}`;}
    else{reason=R.INSUFFICIENT_MARGIN;detail=`${freeMargin.toFixed(2)}<${(Math.ceil((cost+buffer)*100-EPS)/100).toFixed(2)}`;}
  }
  return {version:ENTRY_CAPACITY_VERSION,capacity,reason,detail,maxSlots,usedSlots:used.size,usedSymbols:[...used].sort(),
    slotRoom,marginSlots,marginSlotsGross,freeMarginUsdt:Number.isFinite(freeMargin)?freeMargin:null,
    liveAvailableUsdt:Number.isFinite(liveAvailable)?liveAvailable:null,snapshotAvailableUsdt:snapshotAvailable,
    unseenLedgerMarginUsdt:unseenLive,reservedPendingUsdt,pendingEntryOrders:pendingEntries.length,holdOrders:holds.length,
    slotCostUsdt:cost,cashBufferUsdt:buffer,ledgerSymbols:booked.map(x=>upper(x.symbol))};
}

/** Can the cycle's lease budget still finish one more piece of work of this size? A missing
 * budget (dry runs, isolated tests) is bounded by the caller's wall clock instead. */
export function budgetCovers(budget,{ms,calls}){
  if(!budget)return true;
  return num(budget.remaining?.())>=ms&&num(budget.callsLeft)>=calls;
}

/** Which UNUSED_SLOT_REASON a refusal of one GPT BUY candidate stands for. */
export function slotReasonOf(reason){
  const r=String(reason??'');
  if(/^(ENTRY_MARGIN_INSUFFICIENT|INSUFFICIENT_MARGIN|EXECUTION_SAFETY_REJECT:INSUFFICIENT_MARGIN)|ACCOUNT_MARGIN_LIMIT/.test(r))return R.INSUFFICIENT_MARGIN;
  if(/^(V11_SLOT_FULL|MAX_SLOTS_REACHED)|ACCOUNT_SLOT_LIMIT/.test(r))return R.MAX_SLOTS_REACHED;
  if(/^PENDING_CAPITAL_RESERVED|PENDING_ORDER_IDENTITY|LIVE_ORDINARY_ORDER/.test(r))return R.PENDING_CAPITAL_RESERVED;
  if(/^(ACCOUNT_SAFETY_BLOCK|PORTFOLIO_CHANGED|ENTRY_CONTROL:(ACCOUNT_|OPERATOR_))/.test(r))return R.ACCOUNT_SAFETY_BLOCK;
  // The BUY itself stopped being valid: a recheck SKIP/ABSTAIN, an expired or refused answer.
  if(/^GPT_/.test(r))return R.NO_DETERMINISTIC_BUY;
  return R.EXECUTION_SAFETY_REJECT;
}

/** The reason an ACCOUNT-scoped stop gives the slots it leaves. A release is account-scoped
 * unless it says otherwise (fail closed), so a stop whose text names no account cause is still an
 * account safety stop -- never "no valid BUY". */
export function accountStopReason(reason){
  const r=slotReasonOf(reason);
  return ACCOUNT_SCOPED_REASONS.includes(r)?r:R.ACCOUNT_SAFETY_BLOCK;
}

/**
 * Every slot the operator allows that is not holding anything when the run ends, each with
 * exactly one reason. The counts always sum to maxSlots - usedSlots.
 *   - slots with no margin behind them: INSUFFICIENT_MARGIN;
 *   - slots whose margin an unresolved entry order holds (or an account hold): PENDING_CAPITAL_RESERVED;
 *   - fundable slots: the account-scoped stop that ended the run if there was one; otherwise one
 *     per BUY candidate refused this run (its own reason), one per BUY the cycle budget did not
 *     reach (EXECUTION_SAFETY_REJECT), and NO_DETERMINISTIC_BUY for the rest.
 * @param cap the latest entryCapacity() of the run
 * @param stop {reason: UNUSED_SLOT_REASON, detail} that ended the loop early, or null
 * @param refusals UNUSED_SLOT_REASON of each BUY candidate tried and refused (symbol-scoped)
 * @param unreached BUY candidates the loop stopped before (budget stops only)
 */
export function unusedSlotAccounting(cap,{stop=null,refusals=[],unreached=0}={}){
  const free=Math.max(0,cap.maxSlots-cap.usedSlots),byReason={};
  const add=(r,n)=>{if(n>0)byReason[r]=(byReason[r]??0)+n;};
  if(cap.reason===R.ACCOUNT_SAFETY_BLOCK)add(R.ACCOUNT_SAFETY_BLOCK,free);
  else if(cap.holdOrders>0)add(R.PENDING_CAPITAL_RESERVED,free);
  else{
    const gross=Math.min(free,cap.marginSlotsGross),net=Math.min(free,cap.marginSlots);
    add(R.INSUFFICIENT_MARGIN,free-gross);add(R.PENDING_CAPITAL_RESERVED,gross-net);
    let left=net;
    if(stop&&ACCOUNT_SCOPED_REASONS.includes(stop.reason)){add(stop.reason,left);left=0;}
    for(const r of refusals){if(left<1)break;add(r,1);left--;}
    if(left>0&&stop?.reason===R.EXECUTION_SAFETY_REJECT){const n=Math.min(left,Math.max(0,unreached));add(R.EXECUTION_SAFETY_REJECT,n);left-=n;}
    add(R.NO_DETERMINISTIC_BUY,left);
  }
  return {free,byReason,stop:stop?{reason:stop.reason,detail:stop.detail??null}:null};
}
