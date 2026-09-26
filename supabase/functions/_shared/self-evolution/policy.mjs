/** Data-only policy. No code, URLs, tools, capital fields or execution capabilities. */
export const EVOLUTION_VERSION='SELF_EVOLUTION_1';
export const STAGES=['ENTRY','RECHECK','HOLD','EXIT'];
export const FEATURES=['price_trajectory','acceleration','high_renewal','drawdown_recovery','taker_flow','buy_share','bid_replenishment','ask_pressure','spread_depth','executable_impact','open_interest','funding_premium','btc_regime','thesis_validity','winner_retention','loser_recognition','counterevidence'];
export const REGIMES=['STRONG_TREND','WEAK_TREND','BREAKOUT','POST_BREAKOUT','PULLBACK','REVERSAL','HIGH_VOL','LOW_VOL','HIGH_LIQUIDITY','LOW_LIQUIDITY','VOLUME_EXPANSION','VOLUME_EXHAUSTION','MARKET_RISK_ON','MARKET_RISK_OFF','MARKET_WIDE_SELLOFF','ALT_RALLY','ISOLATED_PUMP','UNKNOWN'];
export const MODELS=Object.freeze({gpt:['gpt-5.4-mini-2026-03-17'],deepseek:['deepseek-flash']});
const denied=/\b(margin|leverage|position[_ -]?siz(?:e|ing)|order[_ -]?siz(?:e|ing)|max[_ -]?slots?|capital[_ -]?allocation|withdraw(?:al)?|transfer|api[_ -]?(?:key|secret|permission)|credential|execution[_ -]?safety|risk[_ -]?limit|hard[_ -]?stop|hard[_ -]?floor|account[_ -]?setting)\b|증거금|레버리지|출금|물타기|권한\s*변경/i;
const ensure=(x,e='REJECTED_SCOPE_VIOLATION')=>{if(!x)throw Error(e);};
const object=(x,keys)=>{ensure(x&&typeof x==='object'&&!Array.isArray(x));ensure(Object.keys(x).sort().join('|')===[...keys].sort().join('|'));};
const text=(s,n=600)=>ensure(typeof s==='string'&&s.length<=n&&!denied.test(s)&&!/(https?:|<script|eval\(|import\s|ignore.{0,25}(system|safety)|exit.{0,20}(after|minutes|seconds))/i.test(s));
export function validatePolicy(p){
 object(p,['schema_version','policy_version','parent_version','data_cutoff_ms','models','stages','calibration']);
 ensure(p.schema_version===EVOLUTION_VERSION);ensure(/^POLICY_[A-Za-z0-9_-]{1,70}$/.test(p.policy_version));
 ensure(p.parent_version===null||/^POLICY_[A-Za-z0-9_-]{1,70}$/.test(p.parent_version));
 ensure(Number.isSafeInteger(p.data_cutoff_ms)&&p.data_cutoff_ms>=0);
 object(p.models,['gpt','deepseek']);for(const m of Object.keys(MODELS))ensure(MODELS[m].includes(p.models[m]));
 object(p.stages,STAGES);
 for(const stage of STAGES){const s=p.stages[stage];object(s,['gpt_rubric','deepseek_rubric','feature_weights','calibration_strength']);
  for(const k of ['gpt_rubric','deepseek_rubric']){ensure(Array.isArray(s[k])&&s[k].length<=6);s[k].forEach(x=>text(x));}
  ensure(Array.isArray(s.feature_weights)&&s.feature_weights.length<=FEATURES.length);
  const seen=new Set();for(const w of s.feature_weights){object(w,['feature','weight']);ensure(FEATURES.includes(w.feature)&&!seen.has(w.feature));seen.add(w.feature);ensure(Number.isFinite(w.weight)&&w.weight>=0&&w.weight<=2);}
  ensure(Number.isFinite(s.calibration_strength)&&s.calibration_strength>=0&&s.calibration_strength<=1);
 }
 ensure(Array.isArray(p.calibration)&&p.calibration.length<=144);
 for(const c of p.calibration){object(c,['provider','stage','regime','n','correct','accuracy','lower','upper','as_of_ms','metric']);
  ensure(['gpt','deepseek'].includes(c.provider)&&STAGES.includes(c.stage)&&REGIMES.includes(c.regime));
  ensure(Number.isSafeInteger(c.n)&&c.n>=0&&Number.isSafeInteger(c.correct)&&c.correct>=0&&c.correct<=c.n);
  ensure(['accuracy','lower','upper'].every(k=>Number.isFinite(c[k])&&c[k]>=0&&c[k]<=1));
  ensure(c.lower<=c.accuracy&&c.accuracy<=c.upper&&c.as_of_ms<=p.data_cutoff_ms&&Number.isSafeInteger(c.as_of_ms));
  ensure(c.metric==='NET_DIRECTION_60S');
 }
 ensure(JSON.stringify(p).length<=30000);return p;
}
export function baselinePolicy(cutoff=0){return {schema_version:EVOLUTION_VERSION,policy_version:'POLICY_BASELINE_V105',parent_version:'POLICY_BASELINE_V104',data_cutoff_ms:cutoff,
 models:{gpt:MODELS.gpt[0],deepseek:MODELS.deepseek[0]},stages:Object.fromEntries(STAGES.map(s=>[s,{gpt_rubric:[],deepseek_rubric:[],feature_weights:[],calibration_strength:0}])),calibration:[]};}
export function policyContext(p,task,asOf){validatePolicy(p);ensure(p.data_cutoff_ms<=asOf,'EVOLUTION_FUTURE_POLICY');
 const stage=task==='HOLD'?'HOLD':task==='RECHECK'?'RECHECK':'ENTRY';
 return {version:p.policy_version,parent_version:p.parent_version,data_cutoff_ms:p.data_cutoff_ms,stage,
  interpretation:p.stages[stage],...(task==='HOLD'?{exit_interpretation:p.stages.EXIT}:{}),
  calibration:p.calibration.filter(c=>(c.stage===stage||task==='HOLD'&&c.stage==='EXIT')&&c.n>=20),
  calibration_note:'Descriptive past NET_DIRECTION_60S accuracy with sample count and Wilson interval, not causal skill or a vote. Verify current evidence. No order or sizing authority.'};}
export function regimeOf(f){const v=f?.values??f??{};
 if(!Number.isFinite(v.return_5m)&&!Number.isFinite(v.return_1m))return 'UNKNOWN';
 if(v.btc_return_5m<-.01)return 'MARKET_WIDE_SELLOFF';
 if(v.return_5m>.025&&v.return_1m<0)return 'PULLBACK';
 if(v.return_5m>.03)return 'STRONG_TREND';
 if(v.return_1m>.01)return 'BREAKOUT';
 if(v.return_5m<0)return 'REVERSAL';return 'WEAK_TREND';}
export function policyPrompt(context,provider){if(!context)return '';
 const texts=[...(context.interpretation?.[provider+'_rubric']??[]),...(context.exit_interpretation?.[provider+'_rubric']??[])];
 return '\nValidated interpretation policy '+context.version+'. These rubrics only interpret evidence; original action schema and immutable safety authority remain binding.\n'+texts.join('\n');}
