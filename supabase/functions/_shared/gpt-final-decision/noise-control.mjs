/** Research-only A/A + B/B control. Four fixed calls, no outcomes or authority. */
import {temporalInputs} from './temporal.mjs';
import {callCounter,MODEL_CANDIDATES} from './parallel.mjs';
export async function compareNoise(row,previous=[],{apiKey,invoke=callCounter}={}){
  const inputs=await temporalInputs(row,previous),order=['A1','B1','B2','A2'];
  const options={...MODEL_CANDIDATES[0],apiKey,timeoutMs:8000,temperature:0};
  const results=await Promise.allSettled(order.map(arm=>invoke(inputs[arm[0]],options)));
  const arms=Object.fromEntries(results.map((r,i)=>[order[i],r.status==='fulfilled'?r.value:{valid:false,error:'PROVIDER_ERROR'}]));
  const agreement=(a,b)=>arms[a]?.valid&&arms[b]?.valid?arms[a].answer.decision_preference===arms[b].answer.decision_preference:null;
  return {version:'DS_NOISE_CONTROL_1',purpose:'DEVELOPMENT_DIAGNOSTIC',authority:[],temperature:0,seed:null,
    history_count:inputs.history_count,input_hashes:{A:inputs.A.snapshot_hash,B:inputs.B.snapshot_hash},arms,
    agreement:{AA:agreement('A1','A2'),BB:agreement('B1','B2'),AB:agreement('A1','B1')}};
}
