---
name: RFQ quoting
description: Price a maker quote inside the formula ask using recent fills and the reference vol, and prefill the RFQ signer.
starter: Help me quote an RFQ for the $3,500 call — what price beats the formula but still makes sense?
---
# RFQ quoting

The RFQ desk lets an LP sign an off-chain quote a buyer can fill; it must undercut the formula ask to matter. The agent prepares, the user signs in the wallet, no key is ever held here.

## Procedure
1. Read the instrument's recent tape: `find_opportunities` (its last-traded premium and implied vol for that strike/expiry) and `reference_market` (Deribit IV, DVOL). Cite the `source` of the tape.
2. `get_onchain_quote` for the formula ask at the requested size — that is the ceiling; a quote above it never fills.
3. Choose the quote: a vol between the reference IV and the formula's sigma_strike, then `price_strategy` at that vol / strike / expiry / size for the premium per unit. Typical: 2–8 % under the formula ask, never below the Black-Scholes price at the reference vol unless the user is deliberately inventory-driven.
4. `prepare_rfq_quote` with authId, strike, size, premium per unit, ttl. "Open in RFQ desk" prefills the signer.

## ttl / nonce hygiene
- ttl: 5–15 minutes on a volatile day, up to an hour when DVOL is low. Longer ttl = free option for the taker.
- Nonce: one per quote; re-quoting the same instrument must use a fresh nonce so the stale one cannot fill after spot moves. If the desk shows an unexpired quote, tell the user to cancel it before signing a new one.
- Size: the quote must fit inside the range's remaining capacity (`liquidity_map`).

## Present
Table: formula ask, reference (BS at Deribit IV), last trade, your quote, edge for the taker, your margin vs reference. One line on what would make the quote wrong (spot move of X, vol move of Y).
