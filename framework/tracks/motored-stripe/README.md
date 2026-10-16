# Motored × Stripe: one gift per real paid order

Replaces the scheduled Motored event (`tracks/motored-event`, launchd timer, random amounts, 480 new
wallets per round). The sender model stays: many event wallets, each giving `donate("motored:user-N")`
to the Arc ShelterSplit `0x457c89e10a6e66633eda5bf82fd086febb5db147` (100% to Pink Paw's wallet
`0x3c833562e682dB66C2415b34961595df135f4771`), funded by the Motored funder
`0xF1d715677877428aE8E95E8ff5385EC44F84688f`. What changed is what a wallet means: **one wallet = one
real paying Motored customer**, the same wallet for every order of that customer.

The Stripe-triggered backend (webhook, keeper, schema) lives in the backend at
`backend/src/shelter/motored/` (see PLAN.md in the app repo). This folder is the public, shareable
money and operations record for it. No keys, seeds or customer data are here.

## Flow (what the backend does, in short)

1. Motored's own Stripe account sends `checkout.session.completed` for one-off orders to
   `POST /shelter/motored/stripe` (subscriptions are out of scope). Signature verified with
   `MOTORED_STRIPE_WEBHOOK_SECRET`.
2. Skip unless paid, live mode (in production), and currency USD/EUR (EUR is converted at a fixed daily
   rate, recorded on the row).
3. `customerKey = sha256(MOTORED_CUSTOMER_SALT + stripe customer id)`; `paymentKey = sha256(…)`. No raw
   customer id, email or name is stored.
4. Find or create the customer's wallet (`motored_wallets { customerKey, n, address, encryptedKey }`).
   `n` is the next free number, continuing after the last event round (so round labels `user-1..480`
   are never reused): the first real customer is `user-481`.
5. Insert one gift keyed by `paymentKey` (unique index, so a resent webhook can't pay twice):
   `motored_gifts { paymentKey, customerKey, n, amountUsdCents, state: 'due', memo, createdAt }`.
6. Send right away: funder → wallet (amount + gas reserve), wallet → `donate(memo)`. Record both tx
   hashes, set `state: 'sent'`, then `confirmed` on receipt.
7. The keeper (`@Cron` every 5 min) only retries `due`/`failed` rows and unlocks stale `sending` rows.

## Amount

Each paid order gives a deterministic whole-cent amount from 1¢ to $1.00, independent of the order
total: `cents = 1 + (uint32(sha256(MOTORED_AMOUNT_SALT + paymentKey)) mod 100)`. No `Math.random()`.
Anyone given the salt after the event can recompute every gift from its row. The public wording is
"Motored gives up to $1 to Pink Paw for every order" — never a round-up or a percentage.

## Money

- During the event Token Tails fronts the USDC: Token Tails tops up the funder `0xF1d7…688f` from a
  Token Tails wallet (not the founder's personal wallet). Each top-up is recorded with its tx hash in
  `funding.json` (`fundedBy: "token-tails"`).
- After the event Token Tails invoices Motored for exactly the USDC given (sum of confirmed gift rows)
  plus gas, and Motored pays it through Stripe. Recorded next to the gift totals
  (`reimbursedBy: "motored"`, `stripeInvoice`, `reimbursedAt`).
- Reporting: the gifts are Motored sponsor money (Motored ends up paying), fronted by Token Tails. The
  reimbursement is a related-party pass-through, **not Token Tails revenue**: keep it out of revenue,
  MRR and ARR in every application and investor answer.

## Refunds and disputes

`charge.refunded` and `charge.dispute.created` are heard. If the gift is still `due`, it is set `void`.
If already sent, it is marked `reversed: 'refunded' | 'disputed'` and shown in the summary. On-chain
gifts are never clawed back.

## Sweeps

A wallet keeps a small gas buffer between orders. The leftover is swept to the split with
`motored:user-N-final` only when the customer has had no order for 90 days, or when the program ends.
No random sweeps.

## Safety

- Daily cap `MOTORED_DAILY_CAP_USD`: above it rows wait as `due` and an alert goes out.
- Funder low-balance alert (below 3 days of average gifts).
- Wallet keys encrypted at rest with `MOTORED_WALLET_KEK`; never logged, never returned by an API.
- Every send re-checks the split pays 100% to Pink Paw (`splitIsSafe`); if it changed, stop and alert.

## Files

| File | What | Public |
|---|---|---|
| `README.md` | This record | yes |
| `funding.json` | Funder top-ups (Token Tails) and the Motored reimbursement | yes |

The live rows live in the backend (`motored_wallets`, `motored_gifts`) and are not stored here; this
folder keeps the money record and the operations summary.
