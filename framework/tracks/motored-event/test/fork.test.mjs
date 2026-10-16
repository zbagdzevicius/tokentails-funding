// Anvil fork test: plan + accelerated runner ticks on a fork of Arc mainnet, with simulated crashes.
// Sends nothing to mainnet. Run: node --test tracks/motored-event/test/fork.test.mjs
// Needs anvil (Foundry), network access to https://rpc.mainnet.arc.io, and ethers (backend/node_modules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ARC, StateLog, loadEthers, rpcClient, usd } from '../lib.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const FORK_URL = process.env.MOTORED_FORK_URL || ARC.rpc;
const hasAnvil = spawnSync('anvil', ['--version']).status === 0;

const freePort = async () => {
  for (let p = 5600; p < 5700; p++) {
    const ok = await new Promise((res) => {
      const s = createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('no free port in 5600-5699');
};

function node(script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf8', env: { ...process.env, MOTORED_RECEIPT_WAIT_MS: '10000', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('fork: plan, ticks, crash recovery, gifts land at Pink Paw', { skip: !hasAnvil && 'anvil not installed', timeout: 600000 }, async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(port), '--silent'], { stdio: 'ignore' });
  const dir = mkdtempSync(join(tmpdir(), 'motored-fork-'));
  try {
    const rpc = rpcClient(url);
    for (let i = 0; i < 120; i++) { try { await rpc.chainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    assert.equal(await rpc.chainId(), ARC.chainId);

    const { Wallet, Interface } = loadEthers();
    const funder = Wallet.createRandom();
    const keyDir = join(dir, 'keys'), outDir = join(dir, 'out');
    spawnSync('mkdir', ['-p', keyDir, outDir]);
    writeFileSync(join(keyDir, 'funder.json'), JSON.stringify([{ address: funder.address, private_key: funder.privateKey }]));
    chmodSync(join(keyDir, 'funder.json'), 0o600);
    await rpc.call('anvil_setBalance', [funder.address, '0x' + (5n * 10n ** 18n).toString(16)]);

    const common = ['--rpc', url, '--key-dir', keyDir, '--out-dir', outDir];
    const pl = node('plan.mjs', [...common, '--count', '12', '--funder', funder.address, '--start', '2026-10-17T09:00:00Z']);
    assert.equal(pl.code, 0, pl.out);
    const plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
    assert.equal(plan.provisional, false);
    assert.equal(plan.budgetWei, (5n * 10n ** 18n).toString());
    const giftSum = BigInt(plan.giftSumWei);

    const shelter0 = await rpc.balance(ARC.shelter);
    const start = '2026-10-17T09:00:00Z';
    // Dry run sends and writes nothing.
    const dry = node('run.mjs', [...common, '--dry-run', '--now', start]);
    assert.equal(dry.code, 0, dry.out);
    assert.equal(new StateLog(join(keyDir, 'state.jsonl')).records.length, 0);

    // Refuses mainnet without the confirm env (no send happens: it throws before anything).
    const guard = node('run.mjs', ['--once', '--key-dir', keyDir, '--out-dir', outDir, '--now', start]);
    assert.notEqual(guard.code, 0);
    assert.match(guard.out, /MOTORED_CONFIRM_MAINNET/);

    const t1 = node('run.mjs', [...common, '--once', '--now', start]);
    assert.equal(t1.code, 0, t1.out);
    // Ticks every 6 hours, two of them crash mid-tx.
    const ticks = [];
    for (let h = 6; h <= 150; h += 6) ticks.push(h);
    for (const h of ticks) {
      const env = h === 30 ? { MOTORED_CRASH: 'after-sign' } : h === 54 ? { MOTORED_CRASH: 'after-send' } : {};
      const r = node('run.mjs', [...common, '--once', '--now', `+${h}h`], env);
      if (env.MOTORED_CRASH) assert.equal(r.code, 9, `expected a simulated crash at +${h}h: ${r.out}`);
      else assert.equal(r.code, 0, r.out);
    }
    // Two more ticks after the end, to settle sweeps.
    for (const h of [151, 152]) { const r = node('run.mjs', [...common, '--once', '--now', `+${h}h`]); assert.equal(r.code, 0, r.out); }

    const state = new StateLog(join(keyDir, 'state.jsonl'));
    const txs = [...state.txs().values()];
    assert.ok(state.records.some((r) => r.type === 'done'), 'event marked done');
    const gifts = txs.filter((r) => r.kind === 'gift');
    assert.equal(gifts.length, plan.giftCount);
    assert.ok(gifts.every((g) => g.status === 'confirmed'), JSON.stringify(gifts.filter((g) => g.status !== 'confirmed')));
    const sweeps = txs.filter((r) => r.kind === 'sweep' && r.status === 'confirmed');
    const sweepSum = sweeps.reduce((t, r) => t + BigInt(r.amountWei), 0n);

    // No double sends: each wallet's on-chain nonce equals its own confirmed tx count.
    const iface = new Interface(['function donate(string memo) payable']);
    for (const w of plan.wallets) {
      const mine = txs.filter((r) => r.wallet === w.id && r.from?.toLowerCase() === w.address.toLowerCase() && r.status === 'confirmed');
      assert.equal(await rpc.nonce(w.address, 'latest'), mine.length, `${w.id} nonce`);
      for (const r of mine) {
        const tx = await rpc.call('eth_getTransactionByHash', [r.hash]);
        assert.equal(tx.to.toLowerCase(), ARC.split.toLowerCase());
        const memo = iface.decodeFunctionData('donate', tx.input)[0];
        assert.equal(memo, r.kind === 'sweep' ? `motored:user-${w.n}-final` : `motored:user-${w.n}`);
        assert.equal(BigInt(tx.value), BigInt(r.amountWei));
      }
    }
    assert.equal(await rpc.nonce(funder.address, 'latest'), plan.walletCount, 'one fund tx per wallet');

    const shelter1 = await rpc.balance(ARC.shelter);
    assert.equal(shelter1 - shelter0, giftSum + sweepSum, `Pink Paw rose by ${usd(shelter1 - shelter0)}`);

    const st = node('status.mjs', [...common, '--now', '+153h']);
    assert.equal(st.code, 0, st.out);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary.countAs, 'sponsor');
    assert.equal(summary.sponsoredGiftsConfirmed, plan.giftCount + sweeps.length);
    assert.ok(!JSON.stringify(summary).includes('private'));
    console.log(`fork: ${plan.giftCount} gifts + ${sweeps.length} sweeps, Pink Paw +${usd(shelter1 - shelter0)} USDC, gas ${summary.gasSpentUsd}`);
  } finally {
    anvil.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
