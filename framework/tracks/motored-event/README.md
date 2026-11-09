# Motored fundraising for cats

> **Retired 2026-11-12.** The event (launchd timer, small random gifts, 480 new wallets per round) ran
> Oct 16 – Nov 12 2026 (rounds 1–3) and is superseded by `tracks/motored-stripe`: one gift per real
> paid Motored order, one wallet per customer, continuing the `user-N` labels from `user-481`. This
> folder stays as the rounds 1–3 record.

Motored sends gifts to Pink Paw through the Arc USDC ShelterSplit
`0x457c89e10a6e66633eda5bf82fd086febb5db147` (`donate(string memo)`, 100% to Pink Paw's wallet
`0x3c833562e682dB66C2415b34961595df135f4771`). Each round provides **480 wallet slots** (user-1..user-480)
funded from the Motored funder `0xF1d7…688f` (a fixed spend cap: the funder's balance). Those wallets
give 1 to 5 small gifts each, $0.01 to $2.00, spread over 6 days. Every memo is `motored:user-N`.

## Honesty

All of this is Motored sponsor money. Motored is one sponsor, and it is linked to the Token Tails
founder. Show it live, from the first gift, as "Motored sponsored gifts to Pink Paw on behalf of its
users". On /impact, the CMS and every report, count it as sponsor money, never as distinct users or
outside wallets. `summary.json` carries `countAs: "sponsor"` and the disclosure. The founder
reconciles after the event.

## Files

| File | What | Public |
|---|---|---|
| `run.mjs` | One runner tick (`--once`) or `--dry-run` | yes |
| `status.mjs` | Progress, writes `summary.json` | yes |
| `lib.mjs` | Shared code: Vilnius timing, state log, RPC | yes |
| `addresses.json` | The 480 event wallet addresses, no keys | yes |
| `summary.json` | Written by the runner: progress, no keys | yes |
| `funding.json` | Funder deposits (the spend cap) with tx hashes | yes |
| `com.tokentails.motored-event.plist` | Copy of the launchd agent | yes |
| `~/.tokentails-wallets/motored-event/wallets.json` | 480 keys, mode 600 | NEVER commit |
| `~/.tokentails-wallets/motored-event/funder.json` | Funder key `0xF1d7…688f` | NEVER commit |
| `~/.tokentails-wallets/motored-event/state.jsonl` | Append-only tx log (raw signed txs) | no |
| `~/.tokentails-wallets/motored-event/run.log` | launchd output | no |

## Money

- The spend cap is the funder's balance: Token Tails tops the funder up once per round (100 USDC round 1,
  14 USDC round 2, 40 USDC round 3), recorded in `funding.json`. The founder's deposits are the only
  money in.
- Gas reserve: fee cap = live gas price x 1.5; donate() gas limit = estimate x 1.25. Each gift and
  each funding tx is reserved at limit x fee cap.
- Gift sum = budget minus reserve, rounded down to a cent. Amounts are log-normal, exact sum.
- If the budget is too small, gift counts and then wallets drop. If it is too large, counts go up to 5
  and the sum is capped at 5 x $2.00 per wallet.
- Each wallet gets exactly its gift total plus its own gas, 2 to 20 minutes before its first gift.
- After a wallet's last gift, a leftover above 0.005 USDC goes to the split as one more gift with
  memo `motored:user-N-final`. Smaller leftovers stay in the wallet.

## Times

Activity is biggest 12:00 to 22:00 Europe/Vilnius, peaking 19:00 to 21:00. Times follow an hourly
weight curve (DST aware: EEST until Oct 25 03:00, then EET) with a mild day to day factor: about 75%
of gifts in 12:00 to 22:00, the rest across 07:00 to 12:00 and 22:00 to 01:00, almost nothing 01:00 to
07:00. Funding txs come just before the first gift of a wallet.

## Safety

- The state log records each tx (with the raw signed tx and nonce) before it is broadcast. On
  restart, an open tx is reconciled by receipt and nonce, and only the same raw tx is rebroadcast.
- A sender gets a new tx only when its earlier txs are resolved. A gift waits for a confirmed fund.
- Each tick checks the split is not paused and pays 100% to Pink Paw, and that the base fee is under
  the fee cap. Otherwise it waits.
- A lock file stops overlapping ticks. The wallet set is fixed at the start.
- Sending on Arc mainnet needs `MOTORED_CONFIRM_MAINNET=yes` (set in the plist only).

## Founder commands

```bash
cd ~/me/tokentails-app/funding/framework/tracks/motored-event
node run.mjs --dry-run               # what a start now would do; sends nothing
cp com.tokentails.motored-event.plist ~/Library/LaunchAgents/   # already there
launchctl load ~/Library/LaunchAgents/com.tokentails.motored-event.plist   # starts the event
caffeinate -s &                      # keep the Mac awake for 6 days (ticks pause while it sleeps)
node status.mjs                      # progress; writes summary.json
tail -f ~/.tokentails-wallets/motored-event/run.log
launchctl unload ~/Library/LaunchAgents/com.tokentails.motored-event.plist # pause or stop
```

After a sleep, the next tick sends every overdue tx at once. Keep the Mac awake to keep the curve.

## Tests

```bash
cd ~/me/tokentails-app/funding/framework
node --test tracks/motored-event/test/unit.test.mjs   # timing curve, DST, state log
node --test tracks/motored-event/test/fork.test.mjs   # anvil fork of Arc mainnet, crash recovery
```
