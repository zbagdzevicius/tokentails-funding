# tokentails-funding

Operational code and on-chain records behind Token Tails' shelter payouts. This is the part of our
internal funding workspace that the public repo
[tokentails](https://github.com/zbagdzevicius/tokentails) refers to. Internal planning
documents are not included. No keys, seeds or passwords are in this repo.

| Path | What |
|---|---|
| `framework/tracks/motored-event*/` | The Motored sponsored fundraising event, rounds 1–3 (retired; kept as the record). |
| `framework/tracks/motored-stripe/` | The Motored × Stripe model that replaced it: one gift per real paid order. |
| `framework/tracks/a-build/` | The Arc ShelterSplit / DonateRouter track: the contract, chain config, deployment records, public wallet addresses, the deploy/payout scripts, the treat agent, and the Arc microgrants + Tameion programs. |
| `framework/lib/core.mjs` | The dependency-free core the a-build track scripts import (`CORE`). |

## Motored × Stripe (current)

Since 2026-11-12 the scheduled event is retired and Motored gives through Stripe: one gift per real paid
Motored order. `tracks/motored-stripe/README.md` is the shareable record; the webhook and keeper live
in the backend (`backend/src/shelter/motored/`). One wallet = one real paying Motored customer (the
same wallet for every order), giving `donate("motored:user-N")` to the same Arc ShelterSplit. The
amount is a deterministic whole-cent $0.01–$1.00 per order. Token Tails fronts the USDC and Motored
reimburses it through Stripe afterwards (a related-party pass-through, not Token Tails revenue).

## The Motored event (rounds 1–3, retired)

Motored is the Token Tails founder's company (a related party). All the money came from one place:
the founder's own wallet `0x29D7d5361052c0990879D7926a0c98A63F9860F8` sent 154 USDC in three
deposits (100 on Oct 16, 14 on Oct 25, 40 on Nov 6; tx hashes in
`framework/tracks/motored-event/funding.json`) to one funder wallet,
`0xF1d715677877428aE8E95E8ff5385EC44F84688f`, that Token Tails controls. Each round funded
480 throwaway wallet slots from that funder (a fixed spend cap), and `run.mjs` sent
small `donate("motored:user-N")` gifts to the Arc ShelterSplit
`0x457c89e10a6e66633eda5bf82fd086febb5db147`, which pays 100% to Pink Paw's wallet
`0x3c833562e682dB66C2415b34961595df135f4771`. Every round reused the labels `user-1` to `user-480`
with new wallets. These wallets are not Motored customers and not separate donors: it is all the
founder's money, given in Motored's name. Each round's `summary.json` has the totals and every
transaction hash. The event ran Oct 16 – Nov 12 2026 (rounds 1–3) and is retired; the Stripe model
above continues the `user-N` labels from `user-481`.

## History

Every commit before the README commit is replayed from our internal funding workspace with its
original date and subject, filtered to the files in this repo (tests that only run in the internal
workspace are left out of every commit). The README and `funding.json` were added on 2026-11-12,
when this repo was created.
