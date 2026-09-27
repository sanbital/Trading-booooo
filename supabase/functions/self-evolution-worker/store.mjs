/** Static datastore interface. Model output is never used as a table, RPC, SQL, URL or action. */
export const TABLES=new Set(['evolution_market_frames','evolution_portfolios','evolution_policy_bundles','evolution_policy_states','evolution_jobs','evolution_reviews','evolution_patterns','evolution_hypotheses','evolution_evaluations','evolution_events','evolution_decisions','evolution_outcomes','evolution_position_policies','evolution_capture','evolution_market_sets','evolution_opportunities','evolution_simulations','evolution_provider_cache','evolution_control']);
export class EvolutionStore{
 constructor(db){this.db=db;}
 table(name){if(!TABLES.has(name))throw Error('EVOLUTION_TABLE_DENIED');return this.db.from(name);}
 async rpc(name,args={}){if(!/^evolution_(register_candidate|market_sensor|capture_context|ingest|claim_job|finish_job|reserve_api|reserve_api_v2|settle_api|worker_heartbeat|report|active_policy|bootstrap|promote|policy_health|rollback)$/.test(name))throw Error('EVOLUTION_RPC_DENIED');const r=await this.db.rpc(name,args);if(r.error)throw Error('EVOLUTION_DB:'+r.error.message);return r.data;}
 async read(query){const r=await query;if(r.error)throw Error('EVOLUTION_READ:'+r.error.message);return r.data;}
 async write(name,value,{upsert=false,onConflict}={}){const table=this.table(name),q=upsert?table.upsert(value,{onConflict}):table.insert(value),r=await q;if(r.error&&r.error.code!=='23505')throw Error('EVOLUTION_WRITE:'+r.error.message);return !r.error;}
 async enqueue(key,kind,payload={},priority=100,availableAt=null){return this.write('evolution_jobs',{dedupe_key:key,kind,payload,priority,...(availableAt?{available_at:availableAt}:{})});}
 async reserve(provider,kind,usd){const id=await this.rpc('evolution_reserve_api_v2',{p_provider:provider,p_kind:kind,p_usd:usd});if(!id)throw Error('RESEARCH_BUDGET_EXHAUSTED');return id;}
 async settle(id,usd,success){return this.rpc('evolution_settle_api',{p_reservation:id,p_actual_usd:usd,p_success:success});}
 async cached(key,fn){const row=await this.read(this.table('evolution_provider_cache').select('result').eq('cache_key',key).maybeSingle());if(row)return row.result;const result=await fn();await this.write('evolution_provider_cache',{cache_key:key,result});return result;}
 // Read-only access to actual execution. No method accepts a mutation or model-generated query.
 async trade(id){return this.read(this.db.from('v11_long_regime_positions').select('*').eq('id',id).single());}
 async fills(id){return this.read(this.db.from('exchange_trade_fills').select('price,quantity,side,fee_quote_amount,executed_at,accounting_status,exchange_trade_id').eq('v17_position_id',id).order('executed_at'));}
 async closedTrades(since){return this.read(this.db.from('v11_long_regime_positions').select('id,signal_id,symbol,entry_at,closed_at,state,realized_pnl_usdt,original_quantity,entry_price,entry_fee_usdt,exit_price,exit_reason').eq('state','CLOSED').gte('closed_at',since).order('closed_at').limit(1000));}
 async journalFor(trade){return this.read(this.table('evolution_decisions').select('*').eq('signal_id',trade.signal_id).order('snapshot_at'));}
}

