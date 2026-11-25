# ExportFlow

**Milestone escrow in stablecoin + an AI document agent for UMKM export-import**, built on **QDay Aevum testnet** (chain `44005`).

An exporter and an importer agree on a deal with several milestones. The buyer locks
`tUSD8` in an escrow contract; funds release per milestone — on the buyer's approval,
on the seller's proof after a response window, or by an arbiter after a dispute. Around
that core sit two supporting pieces: a **session-key policy contract** that lets an
automation agent act inside hard limits, and a **document registry + AI PO reader** that
turns a purchase order into an on-chain hash anchor and flags prompt-injection attempts.

> Testnet only. tQDAY and tUSD8 on Aevum are worthless test tokens; this project issues
> no tokens and promises no returns.

**Based on [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs)** —
chain config, the EIP-3009 gasless relayer and the web scaffolding come from that kit.
See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

---

## Contents

- [Live demo](#live-demo)
- [Deployed contracts (Aevum testnet)](#deployed-contracts-aevum-testnet)
- [On-chain evidence](#on-chain-evidence)
- [What it does — the demo path](#what-it-does--the-demo-path)
- [Architecture](#architecture)
- [Session keys without a bundler](#session-keys-without-a-bundler)
- [Gas and safety notes](#gas-and-safety-notes)
- [Repository layout](#repository-layout)
- [Run it locally](#run-it-locally)
- [Tests](#tests)
- [Security](#security)
- [Roadmap](#roadmap)

---

## Live demo

```bash
pnpm install
cp web/.env.example web/.env.local   # fill in the contract addresses (table below)
pnpm dev                            # http://localhost:3000
```

Pages: **Setup** (wallet/network check) · **Trade** (the escrow flow) · **PO Reader**
(document → fields + injection scan + hash anchor) · **Sessions** (session-key grant,
agent actions, revoke) · **Activity** (on-chain events) · **Docs**.

---

## Deployed contracts (Aevum testnet)

| Contract | Address | Deploy tx |
|---|---|---|
| `Escrow` | [`0x0b9165e8665e76485ac8cf48c69e09352a7ae1aa`](https://explorer-test.qday.info/address/0x0b9165e8665e76485ac8cf48c69e09352a7ae1aa) | [`0xce3da55c…39417b`](https://explorer-test.qday.info/tx/0xce3da55c4f379e15d7eb4592d164ae48215156d9c6ca3e953c93b355c839417b) |
| `SessionPolicy` | [`0xf41f86877b70fa88bca81c6da9a9573b5a59e753`](https://explorer-test.qday.info/address/0xf41f86877b70fa88bca81c6da9a9573b5a59e753) | [`0x387ad462…429691`](https://explorer-test.qday.info/tx/0x387ad4626e05bdc226eec4758bc2715ce9417e8c48dedd711ca691e955429691) |
| `DocRegistry` | [`0xf9f0fdd9750c2333cc4843a68fb9191e7af3e879`](https://explorer-test.qday.info/address/0xf9f0fdd9750c2333cc4843a68fb9191e7af3e879) | [`0xd636bd68…1d9c2a`](https://explorer-test.qday.info/tx/0xd636bd681607755f41333c7070a894d7b5474b57e556194b82ba4cc0291d9c2a) |

- Token: **tUSD8** [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) (6 decimals, EIP-3009)
- Escrow deploy block: **3920736** (`NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM`)
- `responseWindow`: **600 s** (10 minutes for the buyer to react to filed proof)
- Source: this repo, commit `a281375` — the explorer's verifier is broken,
  so verification is by source link (a known Aevum limitation, see the starter kit FAQ)

---

## On-chain evidence

End-to-end run of the full flow (`web/tools/e2e-fund.mjs`, buyer = relayer wallet, all
on Aevum testnet):

| Step | Tx | Result |
|---|---|---|
| `Escrow.create` (2 milestones, 1.5 + 0.5 tUSD8) | [`0xb3b9a3bf…37a5c8e`](https://explorer-test.qday.info/tx/0xb3b9a3bf8578fb9f45855836d3302d6c7f1587b3670deef6afc55558337a5c8e) | state → `Created` |
| Gasless fund: buyer signs EIP-3009, relayer submits (`/api/relay`) | [`0xa517ddbb…ac84c56`](https://explorer-test.qday.info/tx/0xa517ddbb7afa42c1a664da37009e842c9da700766e3618c1d9486b823ac84c56) | buyer paid **0 gas**; state → `Funded` |
| `Escrow.approveMilestone(0)` → seller | [`0x997a194b…9a78a61`](https://explorer-test.qday.info/tx/0x997a194b4f46903911f927998d76c7a8040f0c60348d4880d992ebe319a78a61) | seller received 1.5 tUSD8 |

Reproduce it with the dev server running: `node web/tools/e2e-fund.mjs`
(testnet-only — the script refuses any chain but `44005`).

---

## What it does — the demo path

1. **Create a deal** (Trade page). Buyer picks seller + arbiter, adds milestones
   (amount + deadline). The contract computes the total from the milestone amounts, so
   the locked sum and the release sum can never disagree.
2. **Fund gaslessly.** The buyer signs one EIP-3009 `ReceiveWithAuthorization`; the
   relayer pays the tQDAY gas. The buyer needs only tUSD8, no gas token.
3. **Seller ships and files proof.** The seller agent (server-side, `/api/agent`) calls
   `submitEvidence` with a document hash. From then the buyer has `responseWindow`
   (600 s) to object; after that the seller can `claim` that milestone unilaterally.
4. **Or the buyer approves directly** — `approveMilestone(i)` releases instantly.
5. **Disputes.** Either party calls `raiseDispute`; the arbiter splits the locked funds
   with `resolveDispute(toSeller, toBuyer)`.
6. **PO Reader.** Paste/upload a purchase order: the agent extracts commercial fields
   (PO number, amounts, incoterms…), scans the raw text for prompt-injection patterns,
   and anchors `keccak256(normalized text)` in `DocRegistry`. The document is treated
   as *data, never as instructions*.
7. **Sessions.** The owner grants a session key limited to a target contract, allowed
   selectors, a call budget, a stablecoin cap and an expiry — then watches the agent
   act inside that cage, and can revoke instantly.

---

## Architecture

```
┌──────────────┐   EIP-3009 sig    ┌───────────────┐   fundWithAuthorization   ┌──────────┐
│ Buyer wallet │ ────────────────▶ │ /api/relay    │ ────────────────────────▶ │  Escrow  │
└──────────────┘                   │ (pays gas)    │                           │ (tUSD8)  │
                                   └───────────────┘                           └────┬─────┘
┌──────────────┐   tx: submitEvidence/claim   ┌──────────────┐                       │
│ Seller agent │ ──────────────────────────▶ │ /api/agent   │ ─────────────────────▶ │
│ (server key) │                             │ (guards on   │                        │
└──────────────┘                             │  chain state)│                        │
                                             └──────────────┘                        │
┌──────────────┐   session key (limited)      ┌───────────────┐                       │
│ Agent hot    │ ──────────────────────────▶ │ SessionPolicy │──allowlist/cap/expiry │
│ key (browser)│                             │   (contract)  │                       │
└──────────────┘                             └───────────────┘                       │
                                                                                     ▼
┌──────────────┐   hash + metadata           ┌───────────────┐              ┌──────────────┐
│ PO Reader UI │ ──────────────────────────▶ │ /api/po       │──▶ DocRegistry (on-chain)│
│ + AI agent   │   injection scan, parse     │ (parser+model)│              └──────────────┘
└──────────────┘                             └───────────────┘
```

Contracts (Foundry, Solidity 0.8.24, Shanghai EVM):

- **`Escrow.sol`** — state machine `None → Created → Funded → (Disputed) → Completed/Refunded/Cancelled`.
  Milestones pack into 2 storage slots each; `token`/`responseWindow` are immutable;
  custom errors; checks-effects-interactions + `nonReentrant` on money paths; evidence
  written lazily. Funding supports both `fund()` (approve + transferFrom) and
  `fundWithAuthorization()` (one EIP-3009 signature, nonce bound to the escrow id so a
  signature can't be replayed against a different deal).
- **`SessionPolicy.sol`** — per-session records: target contract, selector allowlist,
  call budget, stablecoin cap, expiry, revoked flag. Every agent call is checked
  against all of them; the owner can revoke in one transaction.
- **`DocRegistry.sol`** — append-only `keccak256` hash anchors with uploader, content
  hash and timestamp.

---

## Session keys without a bundler

Aevum has **no officially supported bundler or paymaster**, so the session-key demo is
implemented as a contract-based policy layer (`SessionPolicy`) instead of ERC-4337
session keys. It maps 1:1 onto native session keys if the platform adds them later —
the same five controls (target, selector, budget, cap, expiry) would move into the
key's own permission scope.

Demo story: the browser generates an **ephemeral hot key** (never the owner's key) that
may only call `DocRegistry.register` and a capped `spend`. The owner grants, the agent
acts within limits, the owner revokes — each boundary violation (over cap, unlisted
selector) reverts with a custom error you can see in the transaction.

---

## Gas and safety notes

Measured on Aevum (~1 gwei): `create` ≈ 189k · `fund` ≈ 60k · `fundWithAuthorization`
≈ 72k · `approveMilestone` ≈ 53k · `claim` ≈ 47k · `submitEvidence` ≈ 44k ·
`refund` ≈ 46k · `raiseDispute` ≈ 31k · `resolveDispute` ≈ 48k.

Design choices for cheap + safe:

- **Packed storage** — `Deal` fits 3 slots + array length, `Milestone` 2 slots (1 until
  proof is filed). No zero-writes on push; `unchecked` loop increments.
- **Immutable** `token` and `responseWindow` (read from code, not storage).
- **Custom errors** instead of revert strings.
- **CEI + `nonReentrant`** on every token-moving function; read-only paths pay no guard slot.
- **No EIP-1153 transient storage** — Aevum is Shanghai, not Cancun (TSTORE would be an
  `invalid opcode` at runtime even though it deploys fine).
- **Totals computed on-chain** from milestone amounts — the contract never trusts a
  client-supplied total.
- **Signature binding** — the EIP-3009 nonce is derived per escrow id, so one
  authorization funds exactly one deal.
- **The relayer never trusts the client**: amount, state and buyer are read from chain
  before it submits anything; it simulates first, caps the signature window, refuses
  known-public keys on live networks and rate-limits per IP/payer.

---

## Repository layout

```
contracts/               Foundry project
  src/Escrow.sol           milestone escrow (the core)
  src/SessionPolicy.sol    session-key allowlist / budget / cap / expiry / revoke
  src/DocRegistry.sol      on-chain hash anchors
  test/*.t.sol             51 unit tests + 3 Aevum fork tests
  script/                  deploy scripts (DeployEscrow, DeployPlatform)
web/                     Next.js app (wagmi + RainbowKit)
  src/app/trade/           escrow flow UI
  src/app/po/              PO reader + injection scan + anchor
  src/app/session/         session-key grant / act / revoke demo
  src/app/api/relay/       gasless relayer (EIP-3009, chain-state guards)
  src/app/api/agent/       seller agent (evidence / claim, chain-state guards)
  src/app/api/po/          deterministic parser + optional model call
  src/lib/doc.ts           normalization, hashing, PO parsing, injection patterns
  tools/e2e-fund.mjs       on-chain end-to-end smoke test (testnet only)
packages/aevum/         chain config + ABIs (from the starter kit)
```

---

## Run it locally

Requires Node 22+, pnpm, Foundry.

```bash
pnpm install            # workspace deps
cd contracts && forge install   # Solidity libs (or: make install at repo root)

# contracts
forge test --no-match-path 'test/fork/*'        # unit tests
forge test --match-path 'test/fork/*' --fork-url https://rpc-test.qday.info   # fork tests

# web
cp web/.env.example web/.env.local              # fill in the addresses above
pnpm typecheck
pnpm build
pnpm dev                                        # http://localhost:3000
```

Faucets: Discord `/faucet <address>` (1 tQDAY + 5 tUSD8) or https://faucet.qday.info.

---

## Tests

- **51 unit tests** — Escrow (state machine, deadlines, dispute, refund, reentrancy,
  totals), SessionPolicy (allowlist, budget, cap, expiry, revoke), DocRegistry.
- **3 fork tests** — the same flows against the real tUSD8 on a local fork of Aevum.
- **Shanghai bytecode check** — the build fails if any contract uses Cancun-only opcodes.
- **On-chain E2E** — `web/tools/e2e-fund.mjs` runs create → gasless fund → release on
  the live testnet (see [On-chain evidence](#on-chain-evidence)).

---

## Security

- **Testnet only.** Keys in `.env.local` / `.keys/` are gitignored; never commit them.
  The deployer and seller wallets used for the demo are throwaway test wallets.
- The PO reader's model prompt explicitly treats the document as data; raw text is
  always scanned for injection patterns regardless of whether a model is configured.
- The relayer and seller-agent API routes re-read chain state on every call — the
  client can't dictate amounts, states or counterparties.
- No token issuance, no promises of returns, no malicious code.

---

## Roadmap

Deferred beyond the hackathon MVP: AdvancePool (financing against locked milestones),
tiered release schedules, seller reputation, and a buyer/seller marketplace.

---

MIT licensed. Based on Aevum Starter Kit © 2026 PQA Labs — see [LICENSE](LICENSE);
third-party licenses in [NOTICE.md](NOTICE.md).
