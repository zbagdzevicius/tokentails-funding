#!/usr/bin/env node
// Plan the Motored fundraising-for-cats event: wallets (keys stay in ~/.tokentails-wallets), gift
// amounts and a 6-day schedule. Reads the funder's balance and the live gas price; sends nothing.
//
//   node plan.mjs                  plan from the funder's on-chain balance (100 USDC, provisional, if 0)
//   node plan.mjs --force          re-plan after the runner started (only with no tx sent)
//   node plan.mjs --start 2026-10-17T12:00:00+03:00   preview the histogram for that start (default now)
//   flags: --rpc URL --count N --seed S --budget-usd X (tests only) --key-dir D --out-dir D
//          --funder 0x.. (fork tests only; the default is the event funder)
//
// Gift times depend on the runner's first tick, so plan.json holds amounts only. run.mjs writes the
// real schedule.json when it starts. The preview here uses --start or now.

import { existsSync, readFileSync } from 'node:fs';
import {
  ARC, DEFAULTS, EVENT, StateLog, buildPlan, buildSchedule, donateData, fmtUsd, fundHistogram, gasTerms,
  hourHistogram, loadEthers, parseFlags, parseNow, paths, renderHistogram, rpcClient, rpcUrl,
  writeJsonAtomic, WEI_PER_USD,
} from './lib.mjs';

const flags = parseFlags(process.argv.slice(2));
const P = paths(flags);
const count = Number(flags.count || DEFAULTS.walletCount);
const seed = flags.seed || DEFAULTS.seed;
const funder = flags.funder || ARC.funder;

function ensureWallets() {
  if (existsSync(P.wallets)) {
    const w = JSON.parse(readFileSync(P.wallets, 'utf8'));
    if (w.length < count) throw new Error(`${P.wallets} has ${w.length} wallets, need ${count}; never regenerated`);
    return { list: w, created: false };
  }
  const { Wallet } = loadEthers();
  const list = Array.from({ length: count }, (_, i) => {
    const w = Wallet.createRandom();
    return { n: i + 1, id: `user-${i + 1}`, address: w.address, privateKey: w.privateKey };
  });
  writeJsonAtomic(P.wallets, list, 0o600);
  return { list, created: true };
}

async function main() {
  const state = new StateLog(P.state);
  const sent = [...state.txs().values()].length;
  if (state.start && !flags.force) {
    throw new Error('the event already started (state log has a start record); re-plan only with --force');
  }
  if (sent > 0) throw new Error(`the state log already has ${sent} transactions; a new plan would not match them`);
  if (state.start && flags.force) state.append({ type: 'replan', note: 'plan.mjs --force before any transaction' });

  const { list, created } = ensureWallets();
  const addresses = list.slice(0, count).map(({ n, id, address }) => ({ n, id, address }));
  writeJsonAtomic(P.addresses, {
    event: EVENT.id,
    note: 'Public addresses of the Motored event wallets (sponsor money, one sponsor). No keys here.',
    count: addresses.length,
    wallets: addresses,
  });

  const rpc = rpcClient(rpcUrl(flags));
  const chainId = await rpc.chainId();
  if (chainId !== ARC.chainId) throw new Error(`RPC chain ${chainId}, expected Arc ${ARC.chainId}`);
  const balance = await rpc.balance(funder);
  const gasPriceWei = await rpc.gasPrice();
  const rich = { [funder]: { balance: '0x' + (10n ** 24n).toString(16) } };
  let donateEstimate = 60000, fundEstimate = 21000;
  const notes = [];
  try {
    donateEstimate = Number(await rpc.estimate({
      from: funder, to: ARC.split, value: '0x' + (2n * WEI_PER_USD).toString(16),
      data: donateData(`motored:user-${count}-final`),
    }, rich));
  } catch (e) { notes.push(`donate() estimate failed (${e.message}); used 60000`); }
  try {
    fundEstimate = Number(await rpc.estimate({ from: funder, to: addresses[0].address, value: '0x1' }, rich));
  } catch (e) { notes.push(`transfer estimate failed (${e.message}); used 21000`); }

  let budgetWei, budgetSource, provisional;
  if (flags['budget-usd']) {
    budgetWei = BigInt(Math.round(Number(flags['budget-usd']) * 100)) * 10n ** 16n;
    budgetSource = 'override';
    provisional = budgetWei > balance;
  } else if (balance > 0n) {
    budgetWei = balance; budgetSource = 'funder-balance'; provisional = false;
  } else {
    budgetWei = DEFAULTS.provisionalBudgetWei; budgetSource = 'provisional-100-usdc'; provisional = true;
  }

  const gas = gasTerms({ gasPriceWei, donateEstimate, fundEstimate });
  const plan = buildPlan({
    budgetWei, gas, addresses, seed,
    opts: { ...DEFAULTS, walletCount: count },
    meta: {
      createdAt: new Date().toISOString(),
      provisional,
      provisionalNote: provisional
        ? 'Planned before the funder was funded. Re-plan with `node plan.mjs` after the funding lands; run.mjs refuses a provisional plan.'
        : undefined,
      budgetSource,
      funder,
      funderBalanceAtPlanWei: balance.toString(),
      notes,
    },
  });
  const previewStart = parseNow(flags.start);
  const preview = buildSchedule(plan, previewStart);
  const hist = hourHistogram(preview);
  const fhist = fundHistogram(preview);
  plan.schedulePreview = {
    note: 'Preview only. The real schedule starts at the runner\'s first tick (schedule.json).',
    startSec: preview.startSec,
    giftsInEventHoursShare: Number(hist.share.toFixed(4)),
    fundsInEventHoursShare: Number(fhist.share.toFixed(4)),
    giftsPerVilniusHour: hist.hours,
  };
  writeJsonAtomic(P.plan, plan);

  const h = (s) => (s / 3600).toFixed(1);
  console.log(`wallets: ${list.length} in ${P.wallets} (${created ? 'created now, mode 600' : 'existing, kept'})`);
  console.log(`budget: ${fmtUsd(plan.budgetWei)} (${budgetSource}${provisional ? ', PROVISIONAL' : ''})`);
  console.log(`gas: live ${Number(gasPriceWei) / 1e9} gwei, fee cap ${Number(gas.feeCapWei) / 1e9} gwei, donate() ${donateEstimate} -> limit ${gas.donateGasLimit}, transfer ${fundEstimate}`);
  console.log(`reserve: ${fmtUsd(plan.reserveWei, 6)} (wallet gas ${fmtUsd(plan.gas.walletGasWei, 6)} + funder gas ${fmtUsd(plan.gas.funderGasWei, 6)} + sub-cent dust)`);
  console.log(`gifts: ${plan.giftCount} from ${plan.walletCount} wallets, sum ${fmtUsd(plan.giftSumWei, 2)} (exactly ${plan.giftSumCents} cents)`);
  const allAt = preview.wallets.flatMap((w) => w.gifts.map((g) => g.at));
  const first = Math.min(...allAt) - preview.startSec, last = Math.max(...allAt) - preview.startSec;
  console.log(`schedule preview from ${new Date(preview.startSec * 1000).toISOString()}: first gift +${h(first)}h, last +${h(last)}h of a ${h(plan.windowSeconds)}h window (Europe/Vilnius curve)`);
  console.log(renderHistogram(hist, 'gifts'));
  console.log(`wallet funding txs: ${(fhist.share * 100).toFixed(1)}% in 12:00-22:00 Vilnius`);
  for (const a of plan.adjustments) console.log(`adjusted: ${a}`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`wrote ${P.plan} and ${P.addresses}`);
}

main().catch((e) => { console.error(`plan: ${e.message}`); process.exit(1); });
