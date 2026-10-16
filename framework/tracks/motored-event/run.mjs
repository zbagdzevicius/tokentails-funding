#!/usr/bin/env node
// Motored event runner. One tick: reconcile open txs, then send every fund, gift and sweep that is
// due now, then write summary.json and exit. launchd calls it every 2 minutes.
//
//   node run.mjs --once               one tick (the launchd agent runs this)
//   node run.mjs --once --dry-run     print what is due now; signs and sends nothing, writes nothing
//   flags: --now T (unix s, ISO, or +Nh from the start; fork tests) --rpc URL --key-dir D --out-dir D
//
// Mainnet safety: a real send to Arc mainnet needs MOTORED_CONFIRM_MAINNET=yes (set in the plist).
// Crash safety: each tx is signed and logged (raw included) before it is broadcast. On restart an
// open record is reconciled by receipt and nonce, and only the same raw tx is ever rebroadcast.
// A sender gets a new tx only when all its earlier txs are resolved, so nonces never collide.

import { existsSync } from 'node:fs';
import {
  ARC, RESOLVED, StateLog, buildSchedule, donateData, fmtUsd, hourHistogram, loadEthers, loadWallets,
  parseFlags, parseNow, paths, planHash, readFunderKey, readJson, rpcClient, rpcUrl, splitIsSafe,
  sweepMemoFor, withLock, writeJsonAtomic,
} from './lib.mjs';
import { writeSummary } from './status.mjs';

const flags = parseFlags(process.argv.slice(2));
const P = paths(flags);
const DRY = Boolean(flags['dry-run']);
const TICK_BUDGET_MS = Number(process.env.MOTORED_TICK_BUDGET_MS || 100000);
const RECEIPT_WAIT_MS = Number(process.env.MOTORED_RECEIPT_WAIT_MS || 20000);
const CRASH = process.env.MOTORED_CRASH; // tests: 'after-sign' or 'after-send' exits mid-tx once

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);

function isMainnetUrl(url) {
  return !/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(url);
}

async function main() {
  if (!flags.once && !DRY) throw new Error('use --once (launchd calls it every 2 minutes) or --dry-run');
  const plan = readJson(P.plan);
  if (!plan) throw new Error(`no plan at ${P.plan}; run plan.mjs first`);
  if (plan.provisional) throw new Error('the plan is provisional; fund the funder, then re-run plan.mjs');
  const url = rpcUrl(flags);
  const rpc = rpcClient(url);
  const chainId = await rpc.chainId();
  if (chainId !== plan.chainId) throw new Error(`RPC chain ${chainId}, plan chain ${plan.chainId}`);
  if (!DRY && isMainnetUrl(url) && process.env.MOTORED_CONFIRM_MAINNET !== 'yes') {
    throw new Error('refusing to send on Arc mainnet without MOTORED_CONFIRM_MAINNET=yes');
  }

  const state = new StateLog(P.state);
  const hash = planHash(plan);
  let start = state.start;
  const now = parseNow(flags.now, start?.startSec);
  if (start && start.planHash !== hash) throw new Error(`plan.json changed after the start (${start.planHash} -> ${hash}); restore it`);

  if (!start) {
    const preview = buildSchedule(plan, now);
    if (DRY) {
      const h = hourHistogram(preview);
      log(`dry-run: not started. A start now would run ${new Date(preview.startSec * 1000).toISOString()} to ${new Date(preview.endSec * 1000).toISOString()}, ${(h.share * 100).toFixed(1)}% of gifts in 12:00-22:00 Vilnius`);
      return dryReport(plan, preview, new Map(), now);
    }
    const bal = await rpc.balance(plan.funder);
    const need = plan.wallets.reduce((t, w) => t + BigInt(w.fundWei), 0n) + BigInt(plan.gas.funderGasWei);
    if (bal < need) throw new Error(`funder ${plan.funder} holds ${fmtUsd(bal)}, plan needs ${fmtUsd(need)}; re-plan`);
    start = state.append({ type: 'start', startSec: preview.startSec, planHash: hash, note: 'Motored sponsor money, one sponsor' });
    writeSchedule(plan, preview);
    log(`started: ${plan.giftCount} gifts from ${plan.walletCount} wallets until ${new Date(preview.endSec * 1000).toISOString()}`);
  }
  const schedule = buildSchedule(plan, start.startSec);
  if (DRY) return dryReport(plan, schedule, state.txs(), now); // dry-run writes nothing
  if (!existsSync(P.schedule)) writeSchedule(plan, schedule);

  const r = await withLock(P.lock, () => tick({ plan, schedule, state, rpc, now }));
  if (r?.locked) log(`another tick (pid ${r.pid}) is running; exit`);
  await writeSummary({ plan, state: new StateLog(P.state), rpc, P, now }).catch((e) => log(`summary: ${e.message}`));
}

function writeSchedule(plan, schedule) {
  writeJsonAtomic(P.schedule, {
    event: plan.event.id,
    note: 'Motored sponsored gifts to Pink Paw on behalf of its users. One sponsor; not distinct users.',
    timeZone: plan.timeZone,
    startSec: schedule.startSec,
    start: new Date(schedule.startSec * 1000).toISOString(),
    end: new Date(schedule.endSec * 1000).toISOString(),
    wallets: schedule.wallets.map((w) => ({ n: w.n, fundAt: w.fundAt, gifts: w.gifts.map((g) => g.at) })),
  });
}

function dueList(plan, schedule, txs, now) {
  const out = [];
  for (const w of plan.wallets) {
    const s = schedule.wallets[w.n - 1];
    const fund = txs.get(`fund:${w.id}`);
    if (!fund && s.fundAt <= now) out.push({ kind: 'fund', w, at: s.fundAt });
    for (const g of w.gifts) {
      const id = `gift:${w.id}:${g.i}`;
      if (!txs.get(id) && s.gifts[g.i - 1].at <= now) out.push({ kind: 'gift', w, g, at: s.gifts[g.i - 1].at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function dryReport(plan, schedule, txs, now) {
  const due = dueList(plan, schedule, txs, now);
  const usd = due.filter((d) => d.kind === 'gift').reduce((t, d) => t + d.g.cents, 0) / 100;
  log(`dry-run at ${new Date(now * 1000).toISOString()}: ${due.length} due (${due.filter((d) => d.kind === 'fund').length} funds, ${due.filter((d) => d.kind === 'gift').length} gifts, $${usd.toFixed(2)})`);
  for (const d of due.slice(0, 20)) {
    log(`  ${d.kind} ${d.w.id}${d.g ? ` #${d.g.i} $${(d.g.cents / 100).toFixed(2)} memo ${d.g.memo}` : ` ${fmtUsd(d.w.fundWei, 6)}`} at ${new Date(d.at * 1000).toISOString()}`);
  }
  if (due.length > 20) log(`  ... ${due.length - 20} more`);
}

// ------------------------------------------------------------------ the tick

async function tick({ plan, schedule, state, rpc, now }) {
  const t0 = Date.now();
  const { Wallet, Transaction } = loadEthers();
  const keys = new Map(loadWallets(P.wallets).map((w) => [w.n, w]));
  const funderKey = readFunderKey(P.funderKey);
  if (funderKey.address.toLowerCase() !== plan.funder.toLowerCase()) throw new Error('funder key does not match plan.funder');
  const signerFor = (n) => {
    if (n === 0) return new Wallet(funderKey.privateKey);
    const k = keys.get(n);
    if (!k) throw new Error(`no key for user-${n}`);
    const w = new Wallet(k.privateKey);
    if (w.address.toLowerCase() !== plan.wallets[n - 1].address.toLowerCase()) throw new Error(`key mismatch for user-${n}`);
    return w;
  };
  const feeCap = BigInt(plan.gas.feeCapWei);
  const outOfTime = () => Date.now() - t0 > TICK_BUDGET_MS;

  // 1. Reconcile every open tx from earlier ticks (or a crash).
  for (const rec of state.txs().values()) {
    if (RESOLVED.has(rec.status)) continue;
    await reconcile(rec, { rpc, state, Transaction });
  }

  // 2. Gas and split guards.
  const base = await rpc.baseFee();
  if (base > feeCap) { log(`base fee ${base} above the plan fee cap ${feeCap}; waiting`); return; }
  const priority = await rpc.priority();
  const prio = priority < feeCap - base ? priority : feeCap - base; // maxPriorityFee never above maxFee
  const safe = await splitIsSafe(rpc, plan.split, plan.shelter);
  if (!safe.ok) { log(`split guard: ${safe.why}; no gifts this tick`); }

  const sendTx = async ({ id, kind, n, from, to, value, data, gasLimit, memo, extra = {} }) => {
    const signer = signerFor(from === 'funder' ? 0 : n);
    const nonce = await rpc.nonce(signer.address, 'latest');
    const pending = await rpc.nonce(signer.address, 'pending');
    if (pending !== nonce) { log(`${id}: ${signer.address} has pending txs we do not know; skip this tick`); return null; }
    const raw = await signer.signTransaction({
      type: 2, chainId: plan.chainId, nonce, to, value, data: data || '0x', gasLimit,
      maxFeePerGas: feeCap, maxPriorityFeePerGas: prio,
    });
    const txHash = Transaction.from(raw).hash;
    const rec = state.append({
      type: 'tx', id, kind, wallet: n ? `user-${n}` : null, from: signer.address, to, nonce,
      amountWei: value.toString(), memo: memo || null, hash: txHash, raw, status: 'signed', ...extra,
    });
    if (CRASH === 'after-sign') { log(`${id}: simulated crash after sign`); process.exit(9); }
    try { await rpc.send(raw); } catch (e) {
      if (!/already known|known transaction|nonce too low/i.test(e.message)) {
        log(`${id}: send error ${e.message}; will reconcile next tick`);
        return rec;
      }
    }
    if (CRASH === 'after-send') { log(`${id}: simulated crash after send`); process.exit(9); }
    state.append({ type: 'tx', id, status: 'sent' });
    return waitAndRecord({ ...rec, status: 'sent' }, { rpc, state });
  };

  // 3. Funds, gifts and sweeps, in time order. Gifts wait for a confirmed fund and the previous gift.
  let txs = state.txs();
  const openFrom = (addr) => [...txs.values()].some((r) => !RESOLVED.has(r.status) && r.from?.toLowerCase() === addr.toLowerCase());
  const due = dueList(plan, schedule, txs, now);
  let sent = 0;
  for (const d of due) {
    if (outOfTime()) { log('tick time budget used; the rest waits for the next tick'); break; }
    txs = state.txs();
    const w = d.w;
    if (d.kind === 'fund') {
      if (openFrom(plan.funder)) continue;
      const value = BigInt(w.fundWei);
      const bal = await rpc.balance(plan.funder);
      if (bal < value + BigInt(plan.gas.fundGasLimit) * feeCap) { log(`fund ${w.id}: funder balance ${fmtUsd(bal)} too low`); continue; }
      const r = await sendTx({ id: `fund:${w.id}`, kind: 'fund', n: w.n, from: 'funder', to: w.address, value, gasLimit: plan.gas.fundGasLimit });
      if (r) { sent++; log(`fund ${w.id} ${fmtUsd(value, 6)} ${r.status} ${r.hash}`); }
    } else {
      if (!safe.ok) continue;
      const fund = txs.get(`fund:${w.id}`);
      if (fund?.status !== 'confirmed') continue; // no gift before its wallet is funded
      if (openFrom(w.address)) continue;
      const prev = d.g.i > 1 ? txs.get(`gift:${w.id}:${d.g.i - 1}`) : null;
      if (d.g.i > 1 && !RESOLVED.has(prev?.status)) continue;
      const value = BigInt(d.g.wei);
      const bal = await rpc.balance(w.address);
      if (bal < value + BigInt(plan.gas.donateGasLimit) * feeCap) {
        state.append({ type: 'tx', id: `gift:${w.id}:${d.g.i}`, kind: 'gift', wallet: w.id, amountWei: value.toString(), memo: d.g.memo, status: 'skipped', why: `wallet balance ${bal} too low` });
        log(`gift ${w.id} #${d.g.i}: skipped, wallet balance too low`);
        continue;
      }
      const r = await sendTx({
        id: `gift:${w.id}:${d.g.i}`, kind: 'gift', n: w.n, from: 'wallet', to: plan.split, value,
        data: donateData(d.g.memo), gasLimit: plan.gas.donateGasLimit, memo: d.g.memo,
      });
      if (r) { sent++; log(`gift ${w.id} #${d.g.i} $${(d.g.cents / 100).toFixed(2)} ${r.status} ${r.hash}`); }
    }
  }

  // 4. Sweeps: after a wallet's last gift resolves, leftovers above 0.005 USDC go to the split.
  txs = state.txs();
  const threshold = BigInt(plan.sweepThresholdWei);
  for (const w of plan.wallets) {
    if (!safe.ok || outOfTime()) break;
    const id = `sweep:${w.id}`;
    if (txs.get(id)) continue;
    const gifts = w.gifts.map((g) => txs.get(`gift:${w.id}:${g.i}`));
    if (!gifts.every((g) => RESOLVED.has(g?.status))) continue;
    if (openFrom(w.address)) continue;
    const bal = await rpc.balance(w.address);
    const gasCost = BigInt(plan.gas.donateGasLimit) * feeCap;
    if (bal <= threshold || bal <= gasCost) {
      state.append({ type: 'tx', id, kind: 'sweep', wallet: w.id, status: 'skipped', why: `leftover ${bal} wei at or below the threshold`, leftoverWei: bal.toString() });
      continue;
    }
    const value = bal - gasCost;
    const memo = sweepMemoFor(w.n);
    const r = await sendTx({ id, kind: 'sweep', n: w.n, from: 'wallet', to: plan.split, value, data: donateData(memo), gasLimit: plan.gas.donateGasLimit, memo });
    if (r) { sent++; log(`sweep ${w.id} ${fmtUsd(value, 6)} ${r.status} ${r.hash}`); }
  }

  txs = state.txs();
  const done = plan.wallets.every((w) => RESOLVED.has(txs.get(`sweep:${w.id}`)?.status));
  if (done && !state.records.some((r) => r.type === 'done')) { state.append({ type: 'done' }); log('event complete: every wallet gave and was swept'); }
  log(`tick done: ${sent} sent`);
}

async function waitAndRecord(rec, { rpc, state }) {
  const until = Date.now() + RECEIPT_WAIT_MS;
  while (Date.now() < until) {
    const rc = await rpc.receipt(rec.hash).catch(() => null);
    if (rc) return recordReceipt(rec, rc, state);
    await sleep(500);
  }
  return rec;
}

function recordReceipt(rec, rc, state) {
  const ok = rc.status === '0x1';
  const feeWei = (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || 0)).toString();
  return state.append({ type: 'tx', id: rec.id, status: ok ? 'confirmed' : 'failed', block: Number(rc.blockNumber), gasUsed: Number(rc.gasUsed), feeWei, hash: rec.hash });
}

async function reconcile(rec, { rpc, state, Transaction }) {
  if (!rec.hash) { state.append({ type: 'tx', id: rec.id, status: 'failed', why: 'no hash recorded' }); return; }
  // An RPC error is not "no receipt": a mined tx must never be marked replaced because a call failed.
  let rc;
  try { rc = await rpc.receipt(rec.hash); } catch (e) { log(`${rec.id}: receipt lookup failed (${e.message}); retry next tick`); return; }
  if (rc) { const r = recordReceipt(rec, rc, state); log(`reconciled ${rec.id}: ${r.status}`); return; }
  const latest = await rpc.nonce(rec.from, 'latest');
  if (latest > rec.nonce) {
    // A node can report the nonce before it serves the receipt: ask once more before giving up on it.
    await sleep(3000);
    const again = await rpc.receipt(rec.hash).catch(() => undefined);
    if (again) { const r = recordReceipt(rec, again, state); log(`reconciled ${rec.id}: ${r.status}`); return; }
    if (again === undefined) { log(`${rec.id}: receipt lookup failed; retry next tick`); return; }
  }
  if (latest > rec.nonce) {
    // The nonce was used by a tx we never logged. Not ours to repeat: mark it and move on.
    state.append({ type: 'tx', id: rec.id, status: 'replaced', why: `nonce ${rec.nonce} used by another tx` });
    log(`reconciled ${rec.id}: replaced (nonce used elsewhere)`);
    return;
  }
  // Not mined: rebroadcast the exact same signed tx (same hash, cannot double-send).
  if (Transaction.from(rec.raw).hash !== rec.hash) throw new Error(`${rec.id}: raw does not match hash`);
  try { await rpc.send(rec.raw); } catch (e) {
    if (!/already known|known transaction/i.test(e.message)) { log(`${rec.id}: rebroadcast error ${e.message}`); return; }
  }
  if (rec.status !== 'sent') state.append({ type: 'tx', id: rec.id, status: 'sent', rebroadcast: true });
  const r = await waitAndRecord({ ...rec, status: 'sent' }, { rpc, state });
  log(`reconciled ${rec.id}: rebroadcast, ${r.status}`);
}

main().catch((e) => { console.error(`run: ${e.message}`); process.exit(1); });
