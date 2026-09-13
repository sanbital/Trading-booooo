import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('./generated/', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const csvRows = async name => {
  const text = await readFile(new URL(name, root), 'utf8');
  // Every generated field containing commas/newlines is quoted. Counting physical lines is
  // sufficient here because JSON-valued cells are single-line.
  return text.trimEnd().split('\n');
};

test('fixed ledger and cause matrix contain exactly 210 trades plus header', async () => {
  assert.equal((await csvRows('trade_truth.csv')).length, 211);
  assert.equal((await csvRows('timeline.csv')).length, 211);
  assert.equal((await csvRows('cause_matrix.csv')).length, 211);
});

test('baseline aggregates reproduce the fixed settlement ledger exactly', async () => {
  const baseline = await json('baseline_metrics.json');
  assert.equal(baseline.cohort.trades, 210);
  assert.equal(baseline.cohort.symbols, 78);
  assert.equal(baseline.winners, 84);
  assert.equal(baseline.losses, 126);
  assert.equal(baseline.netPnlUsdt, -10.27714339);
  assert.equal(baseline.profitFactor, 0.9565051439815601);
});

test('post-cutoff POLYX and BTW are not silently added to the fixed cohort', async () => {
  const truth = await readFile(new URL('trade_truth.csv', root), 'utf8');
  assert.equal(truth.includes('2938b901-5f4e-4c14-ac28-b3b849612801'), false);
  assert.equal(truth.includes('8d9d800f-9107-4f5b-b648-7dbf56dab07e'), false);
  const cases = await json('core_cases.json');
  for (const id of ['2938b901-5f4e-4c14-ac28-b3b849612801','8d9d800f-9107-4f5b-b648-7dbf56dab07e'])
    assert.equal(cases.find(row => row.id === id)?.cohortRole, 'POST_CUTOFF_CASE_ONLY');
});

test('current audit preserves and explains the fill timestamp correction', async () => {
  const reconciliation = await json('baseline_reconciliation.json');
  assert.deepEqual(reconciliation.rawFillTimes, {
    originalPackageExact:208, originalPackageFallback:2, currentAuditExact:209, currentAuditFallback:1,
    newlyRecoveredPositionId:'6320bad6-d86b-48be-bbdc-775a685ffcb6',
    recoverySource:'exchange_trade_fills', steemDbLagMs:56054,
  });
});

test('CVC missing JOIN is retained as a positive raw-order fill reconciliation', async () => {
  const reconciliation = await json('baseline_reconciliation.json');
  assert.equal(reconciliation.cvcException.exchangeTradeFillJoinRows, 0);
  assert.equal(reconciliation.cvcException.rawEntryTradeIds.length, 4);
  assert.equal(reconciliation.cvcException.nativeTradeIds.length, 3);
  assert.equal(reconciliation.cvcException.entryFeeUsdt, 0.06000895);
  assert.equal(reconciliation.cvcException.exitFeeUsdt, 0.05923829);
});

test('candidate comparison cannot pass a missing execution/account replay', async () => {
  const comparison = await json('candidate_comparison.json');
  for (const name of ['E1','X1','E1_X1']) assert.equal(comparison[name].verdict, 'DEFER');
  assert.equal(comparison.promotion.eligible, false);
  assert.equal(comparison.promotion.deployed, false);
});

test('blanket fast-weak deletion records both avoided losses and damaged winners', async () => {
  const comparison = await json('candidate_comparison.json');
  const row = comparison.E1.blanketVetoCounterfactual;
  assert.equal(row.affected, 28);
  assert.equal(row.winnersMissed, 10);
  assert.equal(row.winnerPnlMissedUsdt, 25.67782978);
  assert.equal(row.lossesAvoided, 18);
  assert.equal(row.lossPnlRemovedUsdt, 35.99042102);
  assert.equal(row.validStrategyResult, false);
});
