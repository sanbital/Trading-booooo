export function rollingCapture(original,at,{ratio=null,mid=null,hash=null}={}){
  const capture=structuredClone(original),last=Number(capture?.trajectory?.at(-1)?.mid),
    scale=Number.isFinite(ratio)?ratio:Number.isFinite(mid)&&last>0?mid/last:1,
    targetEnd=at-2000,shift=targetEnd-Number(capture.end_ms);
  delete capture.entry_window;
  capture.start_ms+=shift;capture.end_ms+=shift;capture.ingested_at_ms=capture.end_ms;
  capture.snapshot_at=at;capture.age_ms=at-capture.end_ms;
  capture.trajectory_started_at=capture.start_ms;capture.trajectory_ended_at=capture.end_ms;
  capture.trajectory_hash=hash??`rolling-${capture.end_ms}`;
  for(const point of capture.trajectory){
    for(const key of ['bucket_ms','start_ms','end_ms','received_at_ms','exchange_event_ms','book_received_at_ms',
      'flow_event_ms','flow_received_at_ms'])if(Number.isSafeInteger(point[key]))point[key]+=shift;
    point.mid*=scale;point.start_mid*=scale;
  }
  return capture;
}

export function depthQuote(base,{receivedAt=null,levels=60,size=1000}={}){
  const bid=Number(base.best_bid),ask=Number(base.best_ask),mid=(bid+ask)/2,step=mid*.00005;
  return {...base,bids:Array.from({length:levels},(_,i)=>[bid-i*step,size]),
    asks:Array.from({length:levels},(_,i)=>[ask+i*step,size]),
    timing:{...(base.timing??{}),...(Number.isSafeInteger(receivedAt)?{received_at_ms:receivedAt}:{})}};
}
