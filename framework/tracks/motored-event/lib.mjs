// Motored fundraising for cats: shared code for plan.mjs, run.mjs and status.mjs.
//
// Every gift here is Motored sponsor money (one sponsor, linked to the Token Tails founder), sent
// through many small wallets so the event shows live activity. It is never counted as distinct users.
//
// Pure planning code has no dependencies. Signing uses ethers v6, loaded lazily from the monorepo
// (backend/node_modules) or from MOTORED_ETHERS_DIR, so the unit tests run without it.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync,
  appendFileSync, mkdirSync, statSync, unlinkSync, readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const KEY_DIR = process.env.MOTORED_KEY_DIR || join(homedir(), '.tokentails-wallets', 'motored-event');

export const EVENT = {
  id: 'motored-fundraising-for-cats',
  label: 'Motored sponsored gifts to Pink Paw on behalf of its users',
  sponsor: 'Motored',
  disclosure:
    'Motored is linked to the Token Tails founder. All of these gifts are Motored sponsor money, sent ' +
    'from many small event wallets so the event shows live activity. Count them as one sponsor, never ' +
    'as distinct users or outside wallets. The founder reconciles the event after it ends.',
  countAs: 'sponsor',
};

export const ARC = {
  chainId: 5042,
  rpc: 'https://rpc.mainnet.arc.io',
  explorer: 'https://explorer.arc.io',
  split: '0x457c89e10a6e66633eda5bf82fd086febb5db147',
  shelter: '0x3c833562e682dB66C2415b34961595df135f4771',
  funder: '0xF1d715677877428aE8E95E8ff5385EC44F84688f',
};

export const WEI_PER_USD = 10n ** 18n; // native USDC on Arc has 18 decimals
export const WEI_PER_CENT = 10n ** 16n;
export const DEFAULTS = {
  walletCount: 480,
  minGifts: 1,
  maxGifts: 5,
  minCents: 1, // $0.01
  maxCents: 200, // $2.00
  windowSeconds: 144 * 3600, // 6 days
  feeSafety: 1.5, // fee cap = live gas price x 1.5
  limitMargin: 1.25, // donate() gas limit = estimate x 1.25
  sweepThresholdWei: 5n * 10n ** 15n, // 0.005 USDC
  provisionalBudgetWei: 100n * WEI_PER_USD,
  seed: 'motored-fundraising-for-cats-2026-10',
};

export const memoFor = (n) => `motored:user-${n}`;
export const sweepMemoFor = (n) => `motored:user-${n}-final`;
export const usd = (wei) => Number(BigInt(wei)) / 1e18;
export const fmtUsd = (wei, dp = 4) => `$${usd(wei).toFixed(dp)}`;

// ------------------------------------------------------------------ deterministic random

/** A small seeded PRNG (sfc32 seeded from sha256). Same seed and label, same stream. */
export function rng(seed, label) {
  const h = createHash('sha256').update(`${seed}|${label}`).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    normal: () => {
      const u = Math.max(next(), 1e-12), v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

// ------------------------------------------------------------------ planning (pure)

const ceilMul = (wei, factor) => {
  // ceil(wei * factor) for a decimal factor, in bigint
  const scaled = BigInt(Math.round(factor * 1e6));
  return (BigInt(wei) * scaled + 999999n) / 1000000n;
};

/** Gas terms from the live price and donate() estimate. */
export function gasTerms({ gasPriceWei, donateEstimate, fundEstimate = 21000, opts = DEFAULTS }) {
  const feeCapWei = ceilMul(gasPriceWei, opts.feeSafety);
  const donateGasLimit = Number(ceilMul(donateEstimate, opts.limitMargin));
  const fundGasLimit = Number(fundEstimate);
  return {
    liveGasPriceWei: BigInt(gasPriceWei),
    feeCapWei,
    donateEstimate: Number(donateEstimate),
    donateGasLimit,
    fundGasLimit,
    perGiftGasWei: BigInt(donateGasLimit) * feeCapWei,
    perFundGasWei: BigInt(fundGasLimit) * feeCapWei,
  };
}

/** Split `totalCents` across `n` gifts, each in [minC, maxC], weighted by `weights`. Exact sum. */
export function splitCents(totalCents, weights, minC, maxC) {
  const n = weights.length;
  if (totalCents < n * minC || totalCents > n * maxC) throw new Error(`cannot split ${totalCents} cents into ${n} gifts`);
  const out = new Array(n).fill(minC);
  let left = totalCents - n * minC;
  let guard = 0;
  while (left > 0 && guard++ < 1000) {
    const active = [];
    for (let i = 0; i < n; i++) if (out[i] < maxC) active.push(i);
    const W = active.reduce((s, i) => s + weights[i], 0);
    let given = 0;
    const pass = left;
    for (const i of active) {
      const add = Math.min(maxC - out[i], Math.floor((pass * weights[i]) / W));
      out[i] += add;
      given += add;
    }
    left -= given;
    if (given === 0) {
      // Round-robin the last few cents, heaviest weight first (ties by index).
      const order = active.slice().sort((x, y) => weights[y] - weights[x] || x - y);
      for (const i of order) {
        if (left === 0) break;
        if (out[i] < maxC) { out[i] += 1; left -= 1; }
      }
    }
  }
  if (left !== 0) throw new Error('splitCents did not converge');
  return out;
}

/**
 * Build the money plan from a budget and gas terms: which wallet gives how many gifts of how much.
 * Deterministic for the same inputs. Times are not in here: they depend on when the runner starts
 * (see buildSchedule). addresses: array of { n, address } for user-1..user-N (index n-1).
 */
export function buildPlan({ budgetWei, gas, addresses, seed = DEFAULTS.seed, opts = DEFAULTS, meta = {} }) {
  budgetWei = BigInt(budgetWei);
  const N0 = Math.min(opts.walletCount, addresses.length);
  const adjustments = [];
  const note = (s) => { if (!adjustments.includes(s)) adjustments.push(s); };
  const rCount = rng(seed, 'counts');
  let counts = Array.from({ length: N0 }, () => rCount.int(opts.minGifts, opts.maxGifts));

  const reserveFor = (cs) =>
    cs.reduce((s, c) => s + BigInt(c) * gas.perGiftGasWei, 0n) + BigInt(cs.length) * gas.perFundGasWei;

  let totalCents = 0;
  for (let iter = 0; iter < 5000; iter++) {
    if (counts.length === 0) throw new Error(`budget ${fmtUsd(budgetWei)} cannot cover the gas of even one wallet`);
    const reserve = reserveFor(counts);
    if (reserve >= budgetWei) { counts = counts.slice(0, -1); note('dropped wallets: gas alone was above the budget'); continue; }
    totalCents = Number((budgetWei - reserve) / WEI_PER_CENT);
    const g = counts.reduce((s, c) => s + c, 0);
    if (totalCents < g * opts.minCents) {
      // Too little money: fewer gifts first (the largest count, last wallet first), then fewer wallets.
      if (counts.some((c) => c > opts.minGifts)) {
        const idx = counts.lastIndexOf(Math.max(...counts));
        counts[idx] -= 1;
        note('reduced gift counts to fit the minimum $0.01 per gift');
      } else {
        counts = counts.slice(0, -1);
        note('dropped wallets to fit the minimum $0.01 per gift');
      }
      continue;
    }
    if (totalCents > g * opts.maxCents) {
      if (counts.some((c) => c < opts.maxGifts)) {
        counts[counts.indexOf(Math.min(...counts))] += 1;
        note('raised gift counts to fit the maximum $2.00 per gift');
        continue;
      }
      // Every wallet at 5 x $2.00: cap the gift sum; the rest stays with the funder.
      totalCents = g * opts.maxCents;
      note('budget above 5 gifts x $2.00 per wallet: gift sum capped, the rest stays with the funder');
    }
    break;
  }

  const N = counts.length;
  const G = counts.reduce((s, c) => s + c, 0);
  const walletGas = counts.reduce((s, c) => s + BigInt(c) * gas.perGiftGasWei, 0n);
  const funderGas = BigInt(N) * gas.perFundGasWei;
  const giftSumWei = BigInt(totalCents) * WEI_PER_CENT;
  const reserveWei = budgetWei - giftSumWei; // gas reserve plus sub-cent dust (and any capped excess)

  // Amounts: log-normal weights, many small gifts and a few large ones.
  const rW = rng(seed, 'weights');
  const weights = Array.from({ length: G }, () => Math.exp(rW.normal() * 0.9));
  const cents = splitCents(totalCents, weights, opts.minCents, opts.maxCents);

  let ci = 0;
  const wallets = counts.map((c, idx) => {
    const n = idx + 1;
    const a = addresses[idx];
    if (!a || a.n !== n) throw new Error(`address list does not match user-${n}`);
    const gifts = Array.from({ length: c }, (_, i) => {
      const k = cents[ci++];
      return { i: i + 1, cents: k, wei: (BigInt(k) * WEI_PER_CENT).toString(), memo: memoFor(n) };
    });
    const giftWei = gifts.reduce((t, g) => t + BigInt(g.wei), 0n);
    const gasWei = BigInt(gifts.length) * gas.perGiftGasWei;
    return {
      n, id: `user-${n}`, address: a.address,
      giftWei: giftWei.toString(), gasWei: gasWei.toString(), fundWei: (giftWei + gasWei).toString(), gifts,
    };
  });

  const check = wallets.reduce((t, w) => t + BigInt(w.giftWei), 0n);
  if (check !== giftSumWei) throw new Error('internal: gift sum mismatch');
  const fundTotal = wallets.reduce((t, w) => t + BigInt(w.fundWei), 0n);
  if (fundTotal + funderGas > budgetWei) throw new Error('internal: plan spends more than the budget');

  return {
    version: 2,
    event: EVENT,
    ...meta,
    seed,
    chainId: ARC.chainId,
    split: ARC.split,
    shelter: ARC.shelter,
    funder: meta.funder || ARC.funder,
    budgetWei: budgetWei.toString(),
    giftSumWei: giftSumWei.toString(),
    giftSumCents: totalCents,
    reserveWei: reserveWei.toString(),
    gas: {
      liveGasPriceWei: gas.liveGasPriceWei.toString(),
      feeCapWei: gas.feeCapWei.toString(),
      donateEstimate: gas.donateEstimate,
      donateGasLimit: gas.donateGasLimit,
      fundGasLimit: gas.fundGasLimit,
      walletGasWei: walletGas.toString(),
      funderGasWei: funderGas.toString(),
      feeSafety: opts.feeSafety,
      limitMargin: opts.limitMargin,
    },
    walletCount: N,
    giftCount: G,
    windowSeconds: opts.windowSeconds,
    timeZone: TZ,
    hourWeights: HOUR_WEIGHTS,
    sweepThresholdWei: opts.sweepThresholdWei.toString(),
    adjustments,
    wallets,
  };
}

// ------------------------------------------------------------------ schedule (Vilnius event hours)

export const TZ = 'Europe/Vilnius';

/**
 * Founder rule: activity is biggest 12:00-22:00 Vilnius, peaking in the evening. Weight per local
 * hour (index = hour of day). Shares: 12-22 about 75%, 07-12 and 22-01 the thinner rest, 01-07
 * almost nothing.
 */
export const HOUR_WEIGHTS = [
  1.0, // 00
  0.05, 0.05, 0.05, 0.05, 0.05, 0.05, // 01-06
  0.8, 1.2, 1.5, 1.8, 2.2, // 07-11
  3.0, 3.2, 3.0, 3.2, 3.6, 4.2, 5.0, 5.6, 5.8, 5.0, // 12-21 (peak 19-20)
  3.0, 2.0, // 22-23
];
export const EVENT_HOURS = [12, 22]; // [from, to) Vilnius

const _hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Local Vilnius hour (0-23) of a unix second, DST included (EEST until Oct 25 03:00, then EET). */
export const vilniusHour = (sec) => Number(_hourFmt.format(new Date(sec * 1000))) % 24;
export const vilniusDay = (sec) => _dayFmt.format(new Date(sec * 1000));
export const inEventHours = (sec) => {
  const h = vilniusHour(sec);
  return h >= EVENT_HOURS[0] && h < EVENT_HOURS[1];
};

/**
 * Absolute times for every fund and gift, from the runner's start. Deterministic for the same plan
 * seed and start minute. Gift times are sampled from the hourly weight curve (plus a mild day to day
 * factor); a wallet's gifts are in order, at least 2 minutes apart; the wallet is funded 2 to 20
 * minutes before its first gift.
 */
export function buildSchedule(plan, startSec) {
  startSec = Math.floor(startSec / 60) * 60;
  const W = plan.windowSeconds;
  const weights = plan.hourWeights || HOUR_WEIGHTS;
  const lo = 300, hi = W - 600; // offsets in seconds
  const minutes = Math.floor((hi - lo) / 60);
  const rDay = rng(plan.seed, `days|${startSec}`);
  const dayFactor = new Map();
  const cdf = new Float64Array(minutes);
  let acc = 0;
  for (let m = 0; m < minutes; m++) {
    const t = startSec + lo + m * 60;
    const d = vilniusDay(t);
    if (!dayFactor.has(d)) dayFactor.set(d, 0.85 + 0.3 * rDay.next());
    acc += weights[vilniusHour(t)] * dayFactor.get(d);
    cdf[m] = acc;
  }
  const sample = (u) => {
    const x = u * acc;
    let a = 0, b = minutes - 1;
    while (a < b) { const mid = (a + b) >> 1; if (cdf[mid] < x) a = mid + 1; else b = mid; }
    return a;
  };
  const rT = rng(plan.seed, `times|${startSec}`);
  const wallets = plan.wallets.map((w) => {
    const offs = w.gifts.map(() => lo + sample(rT.next()) * 60 + rT.int(0, 59)).sort((x, y) => x - y);
    for (let i = 1; i < offs.length; i++) offs[i] = Math.max(offs[i], offs[i - 1] + 120);
    const lead = rT.int(120, 1200);
    const fundOff = Math.max(0, offs[0] - lead);
    return {
      n: w.n,
      fundAt: startSec + fundOff,
      gifts: w.gifts.map((g, i) => ({ i: g.i, at: startSec + offs[i] })),
    };
  });
  return { startSec, endSec: startSec + W, wallets };
}

/** Hourly histogram (Vilnius local hour) of gift times and the share inside the event hours. */
export function hourHistogram(schedule) {
  const hours = new Array(24).fill(0);
  let total = 0, inside = 0;
  for (const w of schedule.wallets) for (const g of w.gifts) {
    hours[vilniusHour(g.at)]++;
    total++;
    if (inEventHours(g.at)) inside++;
  }
  return { hours, total, inside, share: total ? inside / total : 0 };
}

export function fundHistogram(schedule) {
  const hours = new Array(24).fill(0);
  let inside = 0;
  for (const w of schedule.wallets) { hours[vilniusHour(w.fundAt)]++; if (inEventHours(w.fundAt)) inside++; }
  return { hours, total: schedule.wallets.length, inside, share: inside / (schedule.wallets.length || 1) };
}

export function renderHistogram(h, label = 'gifts') {
  const max = Math.max(...h.hours, 1);
  const lines = [`${label} per Vilnius hour (${h.total} total, ${(h.share * 100).toFixed(1)}% in 12:00-22:00):`];
  for (let i = 0; i < 24; i++) {
    const mark = i >= EVENT_HOURS[0] && i < EVENT_HOURS[1] ? '*' : ' ';
    lines.push(`  ${String(i).padStart(2, '0')}:00${mark} ${String(h.hours[i]).padStart(4)} ${'#'.repeat(Math.round((h.hours[i] / max) * 40))}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ files

export function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeJsonAtomic(p, obj, mode) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, p);
}

/** Read the private wallets file (keys). Refuses a file other users can read. */
export function loadWallets(p) {
  if (!existsSync(p)) throw new Error(`no wallets file at ${p}; run plan.mjs first`);
  const mode = statSync(p).mode & 0o777;
  if (mode & 0o077) throw new Error(`${p} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function readFunderKey(p = join(KEY_DIR, 'funder.json')) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const row = Array.isArray(j) ? j[0] : j;
  return { address: row.address, privateKey: row.private_key || row.privateKey };
}

// ------------------------------------------------------------------ state log (append-only JSONL)

/**
 * The log is JSON Lines: one record per line, appended and fsynced. Appends never rewrite earlier
 * records, and a torn last line (crash mid-write) is ignored on read.
 */
export class StateLog {
  constructor(p) {
    this.path = p;
    this.records = [];
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.records.push(JSON.parse(line)); } catch { /* torn tail */ }
      }
    }
  }
  append(rec) {
    const r = { seq: this.records.length + 1, t: new Date().toISOString(), ...rec };
    mkdirSync(dirname(this.path), { recursive: true });
    // A torn last line (crash mid-write) must not swallow this record: start on a fresh line.
    let lead = '';
    if (existsSync(this.path)) {
      const size = statSync(this.path).size;
      if (size > 0) {
        const fdr = openSync(this.path, 'r');
        const b = Buffer.alloc(1);
        readSync(fdr, b, 0, 1, size - 1);
        closeSync(fdr);
        if (b[0] !== 10) lead = '\n';
      }
    }
    const fd = openSync(this.path, 'a', 0o600);
    appendFileSync(fd, lead + JSON.stringify(r) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    this.records.push(r);
    return r;
  }
  /** The latest start record after the latest replan record. */
  get start() {
    let s = null;
    for (const r of this.records) {
      if (r.type === 'replan') s = null;
      if (r.type === 'start') s = r;
    }
    return s;
  }
  /** Latest record per tx id, merged so earlier fields (raw, nonce) stay visible. */
  txs() {
    const m = new Map();
    for (const r of this.records) {
      if (r.type !== 'tx') continue;
      m.set(r.id, { ...(m.get(r.id) || {}), ...r });
    }
    return m;
  }
}

export const RESOLVED = new Set(['confirmed', 'failed', 'replaced', 'skipped']);

/** A stable hash of what the runner executes, so a changed plan cannot meet an old state log. */
export function planHash(plan) {
  const core = {
    budgetWei: plan.budgetWei, gas: plan.gas, wallets: plan.wallets, split: plan.split, chainId: plan.chainId,
    funder: plan.funder, seed: plan.seed, windowSeconds: plan.windowSeconds, hourWeights: plan.hourWeights,
  };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ lock

export function withLock(p, fn) {
  mkdirSync(dirname(p), { recursive: true });
  try {
    const fd = openSync(p, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const pid = Number(readFileSync(p, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    if (alive) return { locked: true, pid };
    unlinkSync(p);
    return withLock(p, fn);
  }
  const release = () => { try { unlinkSync(p); } catch { /* already gone */ } };
  process.on('exit', release);
  return Promise.resolve()
    .then(fn)
    .finally(release);
}

// ------------------------------------------------------------------ JSON-RPC

export function rpcClient(url) {
  let id = 0;
  const call = async (method, params = []) => {
    // A hung RPC must not hang the tick: launchd starts no new tick while one still runs.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(Number(process.env.MOTORED_RPC_TIMEOUT_MS || 15000)),
    });
    const j = await res.json();
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message}`);
      e.rpc = j.error;
      throw e;
    }
    return j.result;
  };
  return {
    call,
    chainId: async () => Number(await call('eth_chainId')),
    balance: async (a) => BigInt(await call('eth_getBalance', [a, 'latest'])),
    nonce: async (a, tag = 'pending') => Number(await call('eth_getTransactionCount', [a, tag])),
    gasPrice: async () => BigInt(await call('eth_gasPrice')),
    priority: async () => {
      try { return BigInt(await call('eth_maxPriorityFeePerGas')); } catch { return 0n; }
    },
    baseFee: async () => {
      const b = await call('eth_getBlockByNumber', ['latest', false]);
      return BigInt(b.baseFeePerGas || 0);
    },
    receipt: (h) => call('eth_getTransactionReceipt', [h]),
    send: (raw) => call('eth_sendRawTransaction', [raw]),
    ethCall: (to, data) => call('eth_call', [{ to, data }, 'latest']),
    estimate: (tx, override) => call('eth_estimateGas', override ? [tx, 'latest', override] : [tx]),
    blockNumber: async () => Number(await call('eth_blockNumber')),
    logs: (f) => call('eth_getLogs', [f]),
  };
}

export const rpcUrl = (flags) => flags.rpc || process.env.MOTORED_RPC || process.env.RPC_ARC_MAINNET || ARC.rpc;

// ------------------------------------------------------------------ ethers (lazy)

let _ethers;
export function loadEthers() {
  if (_ethers) return _ethers;
  const roots = [
    process.env.MOTORED_ETHERS_DIR,
    resolve(HERE, '..', '..'), // funding/framework
    resolve(HERE, '..', '..', '..', '..', 'backend'), // tokentails-app/backend
  ].filter(Boolean);
  for (const r of roots) {
    try {
      const req = createRequire(join(r, 'package.json'));
      _ethers = req('ethers');
      return _ethers;
    } catch { /* next */ }
  }
  throw new Error('ethers not found: run npm install in backend/ or set MOTORED_ETHERS_DIR');
}

export function donateData(memo) {
  const { Interface } = loadEthers();
  return new Interface(['function donate(string memo) payable']).encodeFunctionData('donate', [memo]);
}

/** Read the split's shelters and check every gift goes 100% to Pink Paw. */
export async function splitIsSafe(rpc, split = ARC.split, shelter = ARC.shelter) {
  const { Interface } = loadEthers();
  const i = new Interface([
    'function paused() view returns (bool)',
    'function preview(uint256) view returns (address[] wallets, uint256[] amounts, uint256 toTreasury)',
  ]);
  const paused = i.decodeFunctionResult('paused', await rpc.ethCall(split, i.encodeFunctionData('paused')))[0];
  if (paused) return { ok: false, why: 'split is paused' };
  const p = i.decodeFunctionResult('preview', await rpc.ethCall(split, i.encodeFunctionData('preview', [WEI_PER_USD])));
  const pays = p.wallets.map((w, k) => [w.toLowerCase(), p.amounts[k]]).filter(([, a]) => a > 0n);
  if (p.toTreasury !== 0n || pays.length !== 1 || pays[0][0] !== shelter.toLowerCase() || pays[0][1] !== WEI_PER_USD) {
    return { ok: false, why: 'split does not pay 100% to Pink Paw right now' };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ flags

export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) f[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) f[k] = argv[++i];
    else f[k] = true;
  }
  return f;
}

/** --now accepts unix seconds, an ISO date, or +<hours>h relative to the event start. */
export function parseNow(v, startSec) {
  if (v === undefined || v === true) return Math.floor(Date.now() / 1000);
  const rel = /^\+(\d+(?:\.\d+)?)h$/.exec(v);
  if (rel) {
    if (startSec == null) throw new Error('--now +Nh needs a started event');
    return startSec + Math.round(Number(rel[1]) * 3600);
  }
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`bad --now ${v}`);
  return Math.floor(t / 1000);
}

export function paths(flags = {}) {
  const keyDir = flags['key-dir'] || KEY_DIR;
  const outDir = flags['out-dir'] || HERE;
  return {
    keyDir,
    outDir,
    wallets: join(keyDir, 'wallets.json'),
    funderKey: flags['funder-key'] || join(keyDir, 'funder.json'),
    state: join(keyDir, 'state.jsonl'),
    lock: join(keyDir, 'run.lock'),
    plan: join(outDir, 'plan.json'),
    addresses: join(outDir, 'addresses.json'),
    summary: join(outDir, 'summary.json'),
    schedule: join(outDir, 'schedule.json'),
  };
}
