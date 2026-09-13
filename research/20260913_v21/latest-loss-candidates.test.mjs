import test from 'node:test';
import assert from 'node:assert/strict';
import {spikeAccelerationEntry,firstBearNearEntry} from './latest-loss-candidates.mjs';

test('spike candidate uses only completed signal features and fails open on missing evidence',()=>{
  assert.equal(spikeAccelerationEntry({dayReturn:.29,return5m:.0272,return15m:.01848}).wouldBlock,true);
  assert.equal(spikeAccelerationEntry({dayReturn:.49,return5m:.0614,return15m:.0998}).wouldBlock,false);
  assert.equal(spikeAccelerationEntry({}).wouldBlock,false);
});

test('first-bear candidate requires an armed, later, completed candle',()=>{
  const armed=[60_000,'100','101','99','100.3','1',119_999];
  assert.equal(firstBearNearEntry({entryPrice:100,favorableCandle:armed,
    candle:{openTimeMs:120_000,closeTimeMs:179_999,open:100.8,close:100.4}}).wouldClose,true);
  assert.equal(firstBearNearEntry({entryPrice:100,favorableCandle:armed,
    candle:{openTimeMs:120_000,closeTimeMs:179_999,open:100.8,close:100.6}}).wouldClose,false);
  assert.equal(firstBearNearEntry({entryPrice:100,favorableCandle:armed,
    candle:{openTimeMs:60_000,closeTimeMs:119_999,open:100.8,close:100.4}}).available,false);
});
