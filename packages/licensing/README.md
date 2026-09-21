# GRAFT licensing backend

The server-side commerce and licensing service for GRAFT. It sells one product (GRAFT) at
one price ($49 USD, one-time) through **Stripe Checkout**, with **Stripe as the Merchant of
Record via Stripe Managed Payments** — Stripe calculates, collects and remits sales tax/VAT
globally. LeftSock Labs does **not** implement or operate any tax system.

This service is the sole authority on whether a payment succeeded. The desktop app never
holds a Stripe secret and cannot fabricate a purchase.

Managed Payments is requested **per Checkout Session**, not merely at the account level:
every session sets `managed_payments[enabled]=true`, all requests pin API version
`2025-03-31.basil`, the client refuses the session parameters Stripe reserves for the
merchant of record (`automatic_tax`, `tax_id_collection`, payment-method controls,
shipping, `invoice_creation`, Connect and `payment_intent_data.*` post-sale fields), and
the GRAFT Product must carry an eligible downloadable-software tax code (`GRAFT_TAX_CODE`
— a name and price alone is not sufficient). You must also activate Managed Payments and
accept its terms in the Stripe Dashboard.

## Architecture

```
Customer ── Buy ─▶ /buy ─▶ Stripe Checkout (Stripe is Merchant of Record, handles tax)
                                  │ pays
                                  ▼
                    Stripe ── signed webhook ─▶ /webhook ─▶ issue license (idempotent)
                                  │
Customer ◀── /success (server verifies the session is paid) ── license key + download link
                                  │
GRAFT desktop ── activate/validate/deactivate ─▶ /licenses/*  (fail-closed license service)
GRAFT desktop / browser ── /download ─▶ entitlement check ─▶ signed installer
```

Both fulfillment paths use the same server-side purchase verifier. The
signature-verified `checkout.session.completed` webhook and `/success` each retrieve the
canonical Checkout Session, configured Price and its Product from Stripe, then require the
paid $49 USD one-time GRAFT line item with quantity one. A Session id or paid state alone is
not entitlement authority, and Managed Payments tax in `amount_total` is intentionally not
treated as the pre-tax item price.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/buy` | Create a Checkout Session and redirect to Stripe |
| GET | `/success?session_id=` | Confirm payment server-side, show the license key + download |
| GET | `/cancel` | Canceled page (no charge) |
| POST | `/webhook` | Signature-verified issuance (`checkout.session.completed`); revocation on a **full** `charge.refunded` (partial refunds keep entitlement); dispute lifecycle: `charge.dispute.created/updated` suspend, `closed:lost`/`funds_withdrawn` revoke, `closed:won\|warning_closed\|prevented`/`funds_reinstated` restore (only the dispute that caused the state can restore it) |
| POST | `/licenses/activate` | `{ license_key, installation_id, instance_name? }` → one seat per distinct `installation_id` (idempotent for the same one), returns an instance id. One pool for every platform: the desktop sends `GRAFT desktop (macOS)` or `GRAFT desktop (Windows)` as the descriptive name |
| POST | `/licenses/validate` | `{ license_key, instance_id? }` → validity (fails closed for revoked/unknown) |
| POST | `/licenses/deactivate` | `{ license_key, instance_id }` → frees a seat |
| POST | `/licenses/feedback` | `{ license_key, responses, client }` → end-of-beta feedback from a recognised private-beta license (active or expired), relayed by the server to the support address with the tester's address as Reply-To; validated, bounded, rate-limited (3/h per license, 20/h per address); the caller can name no recipient |

| POST | `/internal/private-beta/issue` | `{ email, reference? }` with `Authorization: Bearer <GRAFT_BETA_APPROVAL_TOKEN>` → issues the standard private-beta license (30 days, one seat; duplicate protection) and emails the invitation; returns masked facts only, never the key; 401 without the credential, 503 when the credential or mail is not configured. Server-to-server for the website's one-click approval. |

### Private Beta Program (no Stripe)

Operator-issued licenses with `licenseType: 'private_beta'`, `issuedAt`, an authoritative `expiresAt`
(30 days by default, at most 90), `maxActivations: 1`, no session and no payment intent (so no Stripe
event can touch them). At or after `expiresAt`, `activate` and `validate` answer `status: 'expired'`
without consuming a seat, and the desktop ends the beta. Purchased licenses keep `expiresAt: null`
and every existing rule. Operator commands (`src/beta-cli.js`: `issue`, `inspect`, `extend`,
`revoke`) run beside the server against the same store under a cross-process lock; see
`docs/commercial-beta-readiness-0.1/PRIVATE-BETA-OPERATOR-RUNBOOK.md`.
| GET | `/download?key=&instance=` | Entitlement check → redirect to the artifact |
| GET | `/health` | `200 ok:true`, or `503 ok:false, deadLetters: n` while any purchase awaits manual review |

### Invariant breach: a paid session without a `payment_intent`

A license is only ever issued with the payment intent that refunds and disputes are matched
by, so a paid Checkout Session that lacks one cannot be issued safely. It should never happen;
when it does the purchase is **dead-lettered**, never lost: the session id, event ids, reason and
timestamps (no customer PII) are stored durably under `deadLetters`, keyed by session so Stripe
retries and the success page converge on one entry and no duplicate license can result; the
webhook is acknowledged `200 {received, quarantined, reference}` (Stripe retries only non-2xx,
and a structurally incomplete event would fail identically on every retry); `/health` turns
`503 ok:false` until the entry is resolved; and the customer sees a "purchase under review" page
with the session id as a reference. A later delivery or `/success` load that does carry the
payment intent issues normally and clears the entry.

The `/licenses/*` responses match the contract the desktop `license-service.js` already
expects, so its proven fail-closed state machine and bounded 30-day offline grace are
reused unchanged.

## Security properties

- Stripe secret and webhook secret come only from the environment; never committed, never
  sent to the client, never placed in a URL/body/log. The desktop knows only the public URL.
- Webhook signatures are verified with HMAC-SHA256, constant-time comparison, and a
  timestamp-tolerance window that rejects replays.
- A full refund, a lost dispute, or withdrawn funds revoke the license server-side; an open
  dispute or inquiry suspends it; the desktop's next validation then fails closed and clears the
  local record. Every transition is appended to the license record's `history`.
- Fail closed everywhere: an unconfigured service refuses to start; an unknown key is
  rejected; only network/5xx/429 map to "temporarily unavailable" (offline grace), while a
  genuine rejection never enters grace.
- The backend is excluded from the desktop app bundle by `scripts/desktop/build.mjs`.

## Running in test mode

1. Copy `.env.example` to `.env` and fill in **test-mode** Stripe values.
2. If `STRIPE_PRICE_ID` is already known, keep it configured. Otherwise run
   `npm run licensing:setup` with `STRIPE_SECRET_KEY` and `GRAFT_TAX_CODE`. New catalog setup
   creates the GRAFT Product and its `$49` default Price in one Product request and prints the
   returned `STRIPE_PRICE_ID`. Persist that non-secret id in the deployment environment.
   If it is absent on a later run, setup rediscovers the stable GRAFT Product metadata and
   reuses its default Price; multiple matches stop for manual resolution instead of creating
   another Product.
3. Start the service:
   `node --env-file=packages/licensing/.env packages/licensing/src/cli.js`.
4. Forward Stripe events locally with the Stripe CLI:
   `stripe listen --forward-to localhost:8787/webhook`, then use the printed `whsec_...` as
   `STRIPE_WEBHOOK_SECRET`.
5. Open `/buy`, complete the Stripe-hosted **test** Checkout, and confirm the signed
   `checkout.session.completed` flow issues one license.
6. Point the desktop build's `packages/desktop/config/product.json` at this service by
   setting `licenseApiBase`, `purchaseUrl` (`<publicUrl>/buy`) and `downloadUrl`, plus the
   identity triple (`storeId`/`productId`/`variantIds`, default `1`/`1`/`[1]`).

## Sandbox (test mode) identifiers

The GRAFT product was created once in the Stripe **sandbox** and is reused — never
recreate it, and never let a second one appear. These ids are not secrets.

| Object | Id | Notes |
| --- | --- | --- |
| Product | `prod_VEhcBjVI2YCiXB` | `GRAFT`, tax code `txcd_10202003` (Downloadable Software - business use) |
| Price | `price_1UEECvGptxlKQ6wefS8VL8OF` | $49.00 USD, one-time, `lookup_key` `graft_desktop_onetime_49` |
| Account | `acct_1UEE78GptxlKQ6we` | US, test mode, Managed Payments enabled |

`npm run licensing:setup` is idempotent through that `lookup_key`: it finds this price and
prints it rather than creating a duplicate product. The secret key is never stored in the
repo — export `STRIPE_SECRET_KEY` in the shell; `packages/licensing/.env` (gitignored)
carries only the non-secret wiring.

## Going live (later, not yet)

Swap the test secret/price/webhook for live-mode values, deploy behind HTTPS, register the
live webhook, and confirm **Stripe Managed Payments** is activated (terms accepted) in the
Dashboard. Every session already requests `managed_payments[enabled]=true`; never add
`automatic_tax` (self-serve Stripe Tax) — Stripe as merchant of record handles tax, and that
parameter is unsupported under Managed Payments.
