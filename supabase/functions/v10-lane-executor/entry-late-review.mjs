/** Join answers completed while this same serial entry queue was being processed.
 * One read pass, no wait/retry loop. A break for account/risk/budget stops discovery.
 * The caller's queue is extended so normal unused-slot accounting still sees it.
 * Discovery only reads completed reviews; it never creates a paid review.
 */
export async function* entryQueueWithLateReviews(queue,{discover,mayDiscover}){
  const hadInitial=queue.length>0,seen=new Set(queue.map(s=>String(s.id)));
  let checked=false;
  for(let index=0;;index++){
    if(index===queue.length){
      if(checked||!hadInitial||!mayDiscover())return;
      checked=true;
      const late=await discover();
      for(const s of late){const id=String(s.id);if(!seen.has(id)){seen.add(id);queue.push(s);}}
      if(index===queue.length)return;
    }
    yield [index,queue[index]];
  }
}
