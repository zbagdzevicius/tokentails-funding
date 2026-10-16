// Unit tests for the Motored event planner and scheduler. No network, no ethers.
// Run: node --test tracks/motored-event/test/unit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS, StateLog, WEI_PER_CENT, buildPlan, buildSchedule, fundHistogram, gasTerms, hourHistogram,
  inEventHours, planHash, splitCents, vilniusHour,
} from '../lib.mjs';

const addresses = Array.from({ length: 480 }, (_, i) => ({ n: i + 1, address: '0x' + (i + 1).toString(16).padStart(40, '0') }));
const gas = gasTerms({ gasPriceWei: 20002000000n, donateEstimate: 58697, fundEstimate: 21000 });
const USD = 10n ** 18n;
const plan100 = buildPlan({ budgetWei: 100n * USD, gas, addresses });
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

test('splitCents: exact sum, bounds respected', () => {
  const w = [1, 5, 0.1, 3, 2, 8];
  const out = splitCents(500, w, 1, 200);
  assert.equal(out.reduce((a, b) => a + b, 0), 500);
  assert.ok(out.every((c) => c >= 1 && c <= 200));
  assert.throws(() => splitCents(5, w, 1, 200));
  assert.throws(() => splitCents(1201, w, 1, 200));
});

test('plan for 100 USDC: gifts sum exactly to budget minus gas reserve', () => {
  const p = plan100;
  assert.equal(p.walletCount, 480);
  const gifts = p.wallets.flatMap((w) => w.gifts);
  assert.equal(gifts.length, p.giftCount);
  assert.ok(p.wallets.every((w) => w.gifts.length >= 1 && w.gifts.length <= 5));
  assert.ok(gifts.every((g) => g.cents >= 1 && g.cents <= 200 && BigInt(g.wei) === BigInt(g.cents) * WEI_PER_CENT));
  assert.equal(gifts.reduce((t, g) => t + BigInt(g.wei), 0n), BigInt(p.giftSumWei));
  assert.equal(BigInt(p.giftSumWei) + BigInt(p.reserveWei), 100n * USD);
  // Reserve covers every gift's gas plus every funding tx at the 1.5x fee cap, and is under a cent of dust above it.
  const gasNeed = BigInt(p.gas.walletGasWei) + BigInt(p.gas.funderGasWei);
  assert.ok(BigInt(p.reserveWei) >= gasNeed);
  assert.ok(BigInt(p.reserveWei) - gasNeed < WEI_PER_CENT);
  assert.ok(gas.feeCapWei * 2n >= 3n * 20002000000n);
  for (const w of p.wallets) {
    assert.equal(BigInt(w.fundWei), BigInt(w.giftWei) + BigInt(w.gasWei));
    assert.ok(w.gifts.every((g) => g.memo === `motored:user-${w.n}`));
  }
});

test('plan is deterministic and the hash follows its content', () => {
  const again = buildPlan({ budgetWei: 100n * USD, gas, addresses });
  assert.deepEqual(again.wallets, plan100.wallets);
  assert.equal(planHash(again), planHash(plan100));
  const other = buildPlan({ budgetWei: 100n * USD, gas, addresses, seed: 'x' });
  assert.notEqual(planHash(other), planHash(plan100));
});

test('small budget: fewer gifts, still exact and above $0.01', () => {
  const p = buildPlan({ budgetWei: 3n * USD, gas, addresses });
  assert.ok(p.adjustments.length > 0);
  const gifts = p.wallets.flatMap((w) => w.gifts);
  assert.ok(gifts.every((g) => g.cents >= 1));
  assert.equal(gifts.reduce((t, g) => t + g.cents, 0), p.giftSumCents);
  assert.equal(BigInt(p.giftSumWei) + BigInt(p.reserveWei), 3n * USD);
});

test('huge budget: more gifts per wallet, capped at 5 x $2.00', () => {
  const p = buildPlan({ budgetWei: 10000n * USD, gas, addresses });
  assert.ok(p.wallets.every((w) => w.gifts.length === 5));
  assert.equal(p.giftSumCents, 480 * 5 * 200);
  assert.ok(p.adjustments.some((a) => /capped/.test(a)));
});

test('Vilnius hours follow DST (EEST until Oct 25 03:00, then EET)', () => {
  assert.equal(vilniusHour(sec('2026-10-24T09:00:00Z')), 12);
  assert.equal(vilniusHour(sec('2026-10-26T09:00:00Z')), 11);
  assert.equal(inEventHours(sec('2026-10-26T19:59:00Z')), true); // 21:59 EET
  assert.equal(inEventHours(sec('2026-10-26T20:00:00Z')), false); // 22:00 EET
});

for (const start of ['2026-10-16T09:00:00Z', '2026-10-16T22:30:00Z', '2026-10-17T03:00:00Z', '2026-10-21T15:00:00Z', '2026-10-24T13:00:00Z']) {
  test(`schedule from ${start}: >=70% of gifts in 12:00-22:00 Vilnius, almost none 01:00-07:00`, () => {
    const s = buildSchedule(plan100, sec(start));
    const h = hourHistogram(s);
    assert.equal(h.total, plan100.giftCount);
    assert.ok(h.share >= 0.70, `share ${h.share}`);
    const night = h.hours.slice(1, 7).reduce((a, b) => a + b, 0);
    assert.ok(night / h.total < 0.02, `night ${night}`);
    const evening = h.hours[18] + h.hours[19] + h.hours[20];
    const morning = h.hours[9] + h.hours[10] + h.hours[11];
    assert.ok(evening > 2 * morning, 'peak in the evening');
    assert.ok(fundHistogram(s).share >= 0.65, 'funding follows the same curve');
    for (const w of s.wallets) {
      assert.ok(w.fundAt >= s.startSec && w.fundAt < w.gifts[0].at, 'funded before the first gift');
      assert.ok(w.gifts[0].at - w.fundAt <= 1200, 'funded just in time');
      for (let i = 1; i < w.gifts.length; i++) assert.ok(w.gifts[i].at >= w.gifts[i - 1].at + 120);
      assert.ok(w.gifts.every((g) => g.at > s.startSec && g.at <= s.endSec));
    }
  });
}

test('schedule is deterministic for the same start minute', () => {
  const a = buildSchedule(plan100, sec('2026-10-16T09:00:10Z'));
  const b = buildSchedule(plan100, sec('2026-10-16T09:00:50Z'));
  assert.deepEqual(a, b);
});

test('state log ignores a torn last line and merges tx records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'motored-unit-'));
  try {
    const p = join(dir, 'state.jsonl');
    const s = new StateLog(p);
    s.append({ type: 'start', startSec: 1, planHash: 'x' });
    s.append({ type: 'tx', id: 'gift:user-1:1', status: 'signed', raw: '0xab', nonce: 0 });
    s.append({ type: 'tx', id: 'gift:user-1:1', status: 'confirmed' });
    appendFileSync(p, '{"type":"tx","id":"gift:user-1:2","sta');
    const r = new StateLog(p);
    assert.equal(r.start.startSec, 1);
    const t = r.txs().get('gift:user-1:1');
    assert.equal(t.status, 'confirmed');
    assert.equal(t.raw, '0xab');
    assert.equal(r.txs().size, 1);
    r.append({ type: 'tx', id: 'gift:user-1:2', status: 'signed' });
    assert.equal(new StateLog(p).txs().get('gift:user-1:2').status, 'signed', 'a record after a torn line survives');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('defaults match the founder design', () => {
  assert.equal(DEFAULTS.walletCount, 480);
  assert.equal(DEFAULTS.windowSeconds, 144 * 3600);
  assert.equal(DEFAULTS.sweepThresholdWei, 5n * 10n ** 15n);
});
