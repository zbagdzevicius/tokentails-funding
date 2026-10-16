# Motored fundraising for cats

Motored sends gifts to Pink Paw through the Arc USDC ShelterSplit
`0x457c89e10a6e66633eda5bf82fd086febb5db147` (`donate(string memo)`, 100% to Pink Paw's wallet
`0x3c833562e682dB66C2415b34961595df135f4771`). 480 event wallets (user-1..user-480) give 1 to 5
gifts each, $0.01 to $2.00, over 6 days from the runner's first tick. Every memo is `motored:user-N`.

## Honesty

All of this is Motored sponsor money. Motored is one sponsor, and it is linked to the Token Tails
founder. Show it live, from the first gift, as "Motored sponsored gifts to Pink Paw on behalf of its
users". On /impact, the CMS and every report, count it as sponsor money, never as distinct users or
outside wallets. `summary.json` carries `countAs: "sponsor"` and the disclosure. The founder
reconciles after the event.

## Files

| File | What | Public |
|---|---|---|
| `plan.mjs` | Makes the wallets (first run only) and `plan.json` from the funder's balance and live gas | yes |
| `run.mjs` | One runner tick (`--once`) or `--dry-run` | yes |
| `status.mjs` | Progress, writes `summary.json` | yes |
| `lib.mjs` | Shared code: plan, Vilnius schedule, state log, RPC | yes |
| `plan.json`, `addresses.json` | Amounts and addresses, no keys | yes |
| `schedule.json`, `summary.json` | Written by the runner: real times and progress, no keys | yes |
| `com.tokentails.motored-event.plist` | Copy of the launchd agent | yes |
| `~/.tokentails-wallets/motored-event/wallets.json` | 480 keys, mode 600 | NEVER commit |
| `~/.tokentails-wallets/motored-event/funder.json` | Funder key `0xF1d7…688f` | NEVER commit |
| `~/.tokentails-wallets/motored-event/state.jsonl` | Append-only tx log (raw signed txs) | no |
| `~/.tokentails-wallets/motored-event/run.log` | launchd output | no |

## Money

- Budget = the funder's balance at plan time (100 USDC, so the plan is final, not provisional).
- Gas reserve: fee cap = live gas price x 1.5; donate() gas limit = estimate x 1.25. Each gift and
  each funding tx is reserved at limit x fee cap.
- Gift sum = budget minus reserve, rounded down to a cent. Amounts are log-normal, exact sum.
- If the budget is too small, gift counts and then wallets go down. If it is too large, counts go up
  to 5 and the sum is capped at 5 x $2.00 per wallet. Every adjustment is listed in `plan.json`.
- Each wallet gets exactly its gift total plus its own gas, 2 to 20 minutes before its first gift.
- After a wallet's last gift, a leftover above 0.005 USDC goes to the split as one more gift with
  memo `motored:user-N-final`. Smaller leftovers stay in the wallet.

## Times (founder rule)

Activity is biggest 12:00 to 22:00 Europe/Vilnius, peaking 19:00 to 21:00. Times are sampled from an
hourly weight curve (DST aware: EEST until Oct 25 03:00, then EET) with a mild day to day factor:
about 75% of gifts in 12:00 to 22:00, the rest across 07:00 to 12:00 and 22:00 to 01:00, almost
nothing 01:00 to 07:00. Funding txs follow the curve because they come just before the first gift.
The schedule is fixed by the plan seed and the start minute, so it is the same on every tick.
`plan.mjs` prints the hourly histogram; the unit tests check at least 70% in 12:00 to 22:00.

## Safety

- The state log records each tx (with the raw signed tx and nonce) before it is broadcast. On
  restart, an open tx is reconciled by receipt and nonce, and only the same raw tx is rebroadcast.
- A sender gets a new tx only when its earlier txs are resolved. A gift waits for a confirmed fund.
- Each tick checks the split is not paused and pays 100% to Pink Paw, and that the base fee is under
  the plan's fee cap. Otherwise it waits.
- A lock file stops overlapping ticks. `plan.json` is hashed at the start; a changed plan stops the runner.
- Sending on Arc mainnet needs `MOTORED_CONFIRM_MAINNET=yes` (set in the plist only).

## Founder commands

```bash
cd ~/me/tokentails-app/funding/framework/tracks/motored-event
node plan.mjs                        # re-plan only if the funder balance changed (before the start)
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
node --test tracks/motored-event/test/unit.test.mjs   # plan, curve, DST, state log
node --test tracks/motored-event/test/fork.test.mjs   # anvil fork of Arc mainnet, crash recovery
```
