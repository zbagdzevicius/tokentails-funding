#!/usr/bin/env node
// Motored event progress. Prints wallets funded, gifts sent/pending/failed, USD to Pink Paw, gas
// spent, funder balance and the next due tx, and writes summary.json (public, no keys).
//
//   node status.mjs              read the chain and the state log
//   node status.mjs --offline    state log only (no RPC)
//   flags: --rpc URL --key-dir D --out-dir D --now T

import { pathToFileURL } from 'node:url';
import {
  ARC, EVENT, RESOLVED, StateLog, buildSchedule, fmtUsd, parseFlags, parseNow, paths, readJson,
  rpcClient, rpcUrl, usd, writeJsonAtomic,
} from './lib.mjs';

export function progress(plan, state, now) {
  const txs = state.txs();
  const start = state.start;
  const all = [...txs.values()];
  const by = (kind, status) => all.filter((r) => r.kind === kind && (!status || r.status === status));
  const sum = (rs) => rs.reduce((t, r) => t + BigInt(r.amountWei || 0), 0n);
  const confirmedGifts = by('gift', 'confirmed');
  const confirmedSweeps = by('sweep', 'confirmed');
  const gasWei = all.reduce((t, r) => t + BigInt(r.feeWei || 0), 0n);
  const toShelterWei = sum(confirmedGifts) + sum(confirmedSweeps);
  let next = null;
  if (start) {
    const sch = buildSchedule(plan, start.startSec);
    for (const w of plan.wallets) {
      const s = sch.wallets[w.n - 1];
      const cand = [];
      if (!txs.get(`fund:${w.id}`)) cand.push({ id: `fund:${w.id}`, at: s.fundAt });
      for (const g of w.gifts) if (!txs.get(`gift:${w.id}:${g.i}`)) cand.push({ id: `gift:${w.id}:${g.i}`, at: s.gifts[g.i - 1].at });
      for (const c of cand) if (!next || c.at < next.at) next = c;
    }
  }
  return {
    started: Boolean(start),
    startSec: start?.startSec ?? null,
    done: state.records.some((r) => r.type === 'done'),
    walletsPlanned: plan.walletCount,
    walletsFunded: by('fund', 'confirmed').length,
    giftsPlanned: plan.giftCount,
    giftsConfirmed: confirmedGifts.length,
    giftsPending: by('gift').filter((r) => !RESOLVED.has(r.status)).length,
    giftsFailed: by('gift').filter((r) => ['failed', 'replaced', 'skipped'].includes(r.status)).length,
    sweepsConfirmed: confirmedSweeps.length,
    toShelterWei,
    plannedGiftWei: BigInt(plan.giftSumWei),
    gasWei,
    next,
    recent: [...confirmedGifts, ...confirmedSweeps]
      .sort((a, b) => b.seq - a.seq).slice(0, 20)
      .map((r) => ({ memo: r.memo, usd: Number(usd(r.amountWei).toFixed(6)), tx: r.hash, at: r.t })),
    now,
  };
}

export async function writeSummary({ plan, state, rpc, P, now }) {
  const p = progress(plan, state, now);
  let shelterBalanceWei = null;
  if (rpc) shelterBalanceWei = (await rpc.balance(plan.shelter)).toString();
  const out = {
    event: EVENT.id,
    label: EVENT.label,
    sponsor: EVENT.sponsor,
    countAs: EVENT.countAs,
    disclosure: EVENT.disclosure,
    chainId: plan.chainId,
    split: plan.split,
    shelter: plan.shelter,
    explorer: ARC.explorer,
    provisional: Boolean(plan.provisional),
    started: p.started,
    startedAt: p.startSec ? new Date(p.startSec * 1000).toISOString() : null,
    done: p.done,
    sponsoredGiftsConfirmed: p.giftsConfirmed + p.sweepsConfirmed,
    sponsoredGiftsPlanned: p.giftsPlanned,
    usdToPinkPaw: Number(usd(p.toShelterWei).toFixed(2)),
    usdPlanned: Number(usd(p.plannedGiftWei).toFixed(2)),
    gasSpentUsd: Number(usd(p.gasWei).toFixed(6)),
    shelterBalanceUsd: shelterBalanceWei ? Number(usd(shelterBalanceWei).toFixed(2)) : null,
    recent: p.recent,
    updatedAt: new Date((now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  writeJsonAtomic(P.summary, out);
  return { p, out };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const P = paths(flags);
  const plan = readJson(P.plan);
  if (!plan) throw new Error(`no plan at ${P.plan}`);
  const state = new StateLog(P.state);
  const now = parseNow(flags.now, state.start?.startSec);
  const rpc = flags.offline ? null : rpcClient(rpcUrl(flags));
  const { p } = await writeSummary({ plan, state, rpc, P, now });
  const funderBal = rpc ? await rpc.balance(plan.funder) : null;
  const iso = (s) => new Date(s * 1000).toISOString();
  console.log(`Motored event (sponsor money, one sponsor). Plan ${plan.provisional ? 'PROVISIONAL' : 'final'}.`);
  console.log(`started: ${p.started ? iso(p.startSec) : 'no'}${p.done ? ' (done)' : ''}`);
  console.log(`wallets funded: ${p.walletsFunded}/${p.walletsPlanned}`);
  console.log(`gifts: ${p.giftsConfirmed}/${p.giftsPlanned} confirmed, ${p.giftsPending} pending, ${p.giftsFailed} failed or skipped; sweeps ${p.sweepsConfirmed}`);
  console.log(`to Pink Paw: ${fmtUsd(p.toShelterWei, 2)} of ${fmtUsd(p.plannedGiftWei, 2)} planned`);
  console.log(`gas spent: ${fmtUsd(p.gasWei, 6)}`);
  if (funderBal !== null) console.log(`funder balance: ${fmtUsd(funderBal, 6)}`);
  console.log(`next due: ${p.next ? `${p.next.id} at ${iso(p.next.at)}` : p.started ? 'nothing scheduled' : 'starts at the first runner tick'}`);
  console.log(`wrote ${P.summary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`status: ${e.message}`); process.exit(1); });
}
