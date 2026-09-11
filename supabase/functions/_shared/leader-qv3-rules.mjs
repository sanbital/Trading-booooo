/** Pure offline strategy rules derived from the latest deployment's trade paths. */
import {nextExitReviewed,EXIT_REVIEW_R5} from './leader-exit-review.mjs';
export const VARIANTS=Object.freeze(['BASELINE','ENTRY','EXIT_ONE','EXIT_TWO','ENTRY_EXIT_ONE','ENTRY_EXIT_TWO']);
function valid(b){const [t,o,h,l,c]=b.map(Number),end=Number(b[6]);return [t,o,h,l,c,end].every(Number.isFinite)&&t%60000===0&&end===t+59999&&l>0&&h>=Math.max(o,c)&&l<=Math.min(o,c);}
export function completed(bars,now){return bars.filter(b=>Number(b[6])<now).sort((a,b)=>a[0]-b[0]);}
function tail(bars,now,n){const xs=completed(bars,now).slice(-n),last=Math.floor(now/60000)*60000-60000;if(xs.length!==n||!xs.every((b,i)=>valid(b)&&Number(b[0])===last-(n-1-i)*60000))return null;return xs;}
export function entryGate(bars,now,variant){
 if(!VARIANTS.includes(variant))throw Error('UNKNOWN_VARIANT');
 if(!variant.startsWith('ENTRY'))return {reject:false};
 const xs=tail(bars,now,3);if(!xs)return {reject:false,unavailable:true};
 return {reject:[1,2].every(i=>Number(xs[i][2])<Number(xs[i-1][2])&&Number(xs[i][4])<Number(xs[i-1][4]))&&xs.slice(-2).every(b=>Number(b[4])<Number(b[1]))};
}
export function exitSignal(position,bars,now,variant){
 if(!VARIANTS.includes(variant))throw Error('UNKNOWN_VARIANT');
 const n=variant.includes('EXIT_TWO')?2:variant.includes('EXIT_ONE')?1:0;
 if(!n)return false;
 if(position.ownership&&position.ownership!=='AUTO')return false;
 const hist=completed(bars,now).filter(b=>Number(b[0])>=position.entryAt&&valid(b));
 if(!hist.some(b=>Number(b[4])>position.entryPrice*1.002))return false;
 const xs=tail(bars,now,n);if(!xs||xs.some(b=>Number(b[0])<position.entryAt))return false;
 return xs.every(b=>Number(b[4])<Number(b[1]))&&(n===1||Number(xs[1][4])<Number(xs[0][4]));
}
export function exitDecision(position,bid,now,variant='BASELINE',bars=[]){
 if(position.ownership&&position.ownership!=='AUTO')return {action:'PRESERVE',executionEnabled:false};
 const d=nextExitReviewed(position,bid,now,{...EXIT_REVIEW_R5,...position.policy});
 if(d.action==='HOLD'&&exitSignal(position,bars,now,variant)){d.action='CLOSE';d.reason=variant.includes('EXIT_TWO')?'QV3_TWO_BEARISH_CLOSED':'QV3_ONE_BEARISH_CLOSED';}
 return {...d,executionEnabled:false};
}
