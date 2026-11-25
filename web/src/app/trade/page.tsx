"use client";

import { authorizationWindow, checkoutTypedData, erc20Abi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract, useReadContracts } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { docHash, SAMPLE_PO } from "@/lib/doc";
import {
  DEMO_ARBITER,
  DEMO_SELLER,
  dealLabel,
  escrowAbi,
  ESCROW_STATE,
  MILESTONE_DEMO,
  newDealId,
  short,
  STATE_LABEL,
  STATE_TONE,
  type EscrowState,
} from "@/lib/exportflow";
import { explain } from "@/lib/errors";
import { useNetwork } from "@/lib/network";

type Phase = "idle" | "working" | "done" | "error";

const ZERO32 = "0x" + "0".repeat(64) as Hex;

interface MilestoneRow {
  label: string;
  amount: string;
  days: string;
}

export default function TradePage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const escrowAddress = net.escrow;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const [dealId, setDealId] = useState<Hex | null>(null);
  const [seller, setSeller] = useState<Address | string>(DEMO_SELLER);
  const [arbiter, setArbiter] = useState<Address | string>(DEMO_ARBITER);
  const [rows, setRows] = useState<MilestoneRow[]>(() => MILESTONE_DEMO.map((m) => ({ label: m.label, amount: m.amount, days: String(m.days) })));

  const [mode, setMode] = useState<"gasless" | "standard">("gasless");
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const [evidenceText, setEvidenceText] = useState(SAMPLE_PO);

  useEffect(() => setDealId(newDealId()), []);

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () => (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean; relayer: string | null }>,
  });
  const gaslessAvailable = relay.data?.enabled ?? false;
  const agent = useQuery({
    queryKey: ["agent-status", appChain.id],
    queryFn: async () => (await fetch(`/api/agent?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean; seller: Address | null }>,
  });

  // ---- chain reads -------------------------------------------------------
  const dealQuery = useReadContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "dealOf",
    args: dealId ? [dealId] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(escrowAddress && dealId), refetchInterval: 8_000 },
  });
  const deal = dealQuery.data;
  const state: EscrowState = deal ? (ESCROW_STATE[deal.state] ?? "None") : "None";

  const windowQuery = useReadContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "responseWindow",
    chainId: appChain.id,
    query: { enabled: Boolean(escrowAddress) },
  });

  const reads = useReadContracts({
    contracts: [
      { address: token.address, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: appChain.id },
      { address: token.address, abi: erc20Abi, functionName: "allowance", args: address && escrowAddress ? [address, escrowAddress] : undefined, chainId: appChain.id },
    ],
    query: { enabled: Boolean(token.address && escrowAddress && address) },
  });
  const balance = reads.data?.[0]?.result;
  const allowance = reads.data?.[1]?.result;

  const total = useMemo(() => {
    if (deal) return deal.total;
    try {
      return rows.reduce((s, r) => s + parseUnits(r.amount || "0", token.decimals), 0n);
    } catch {
      return 0n;
    }
  }, [deal, rows, token.decimals]);

  const isBuyer = Boolean(address && deal && deal.buyer.toLowerCase() === address.toLowerCase());
  const isSeller = Boolean(address && deal && deal.seller.toLowerCase() === address.toLowerCase());
  const isArbiter = Boolean(address && deal && deal.arbiter.toLowerCase() === address.toLowerCase());
  const busy = phase === "working";

  function fail(e: unknown) {
    setError(explain(e));
    setPhase("error");
  }

  async function wait(hash: Hash) {
    const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
    if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing changed.");
    setTxHash(hash);
    dealQuery.refetch();
    reads.refetch();
    return receipt;
  }

  // ---- 1. create ----------------------------------------------------------
  async function createDeal() {
    if (!escrowAddress || !dealId) return;
    setError(null);
    setNotice(null);
    setPhase("working");
    setStep(0);
    try {
      const now = Math.floor(Date.now() / 1000);
      const milestones = rows.map((r) => ({
        amount: parseUnits(r.amount || "0", token.decimals),
        deadline: BigInt(now + Number(r.days || 1) * 86_400),
      }));
      if (milestones.some((m) => m.amount <= 0n)) throw new Error("Every milestone needs an amount above zero.");
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(seller)) || !/^0x[0-9a-fA-F]{40}$/.test(String(arbiter))) {
        throw new Error("Seller and arbiter must be 0x addresses.");
      }
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "create",
        args: [dealId, seller as Address, arbiter as Address, milestones],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      setStep(1);
      await wait(hash);
      setNotice("Deal created. Fund it to start the milestones.");
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  // ---- 2. fund ------------------------------------------------------------
  async function fundGasless() {
    if (!address || !escrowAddress || !dealId || !token.address) return;
    const nonce = (await readContract(config, {
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "authorizationNonce",
      args: [dealId],
      chainId: appChain.id,
    })) as Hex;
    const { validAfter, validBefore } = authorizationWindow(600);
    // tUSD8's EIP-712 message is the standard ReceiveWithAuthorization: same struct for the
    // escrow, with `to` = Escrow and the nonce bound to (Escrow, dealId) on chain.
    const signature = await signTypedData(config, {
      account: address,
      ...checkoutTypedData(appChain.id, token.address, { from: address, to: escrowAddress, value: deal!.total, validAfter, validBefore, nonce }),
    });
    setStep(1);
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "fundEscrow",
        chainId: appChain.id,
        escrowId: dealId,
        from: address,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "The relayer didn't accept the funding.");
    setTxHash(data.hash);
    setStep(2);
    return data.hash;
  }

  async function fundStandard() {
    if (!address || !escrowAddress || !dealId || !token.address || !deal) return;
    // Approve exactly the deal total, never unlimited.
    if ((allowance ?? 0n) < deal.total) {
      const approveHash = await writeContract(config, {
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [escrowAddress, deal.total],
        chainId: appChain.id,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    setStep(1);
    const { request } = await simulateContract(config, {
      account: address,
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "fund",
      args: [dealId],
      chainId: appChain.id,
    });
    return writeContract(config, request);
  }

  async function fund() {
    setError(null);
    setNotice(null);
    setPhase("working");
    setStep(0);
    try {
      const hash = mode === "gasless" ? await fundGasless() : await fundStandard();
      if (!hash) throw new Error("Connect your wallet first.");
      await wait(hash);
      setNotice(mode === "gasless" ? "Funded gasless: your wallet signed, the relayer paid the gas." : "Funded from your wallet.");
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  // ---- 3. milestones ------------------------------------------------------
  async function approve(index: number) {
    if (!escrowAddress || !dealId) return;
    setError(null);
    setPhase("working");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "approveMilestone",
        args: [dealId, BigInt(index)],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await wait(hash);
      setNotice(`Milestone ${index + 1} released to the seller.`);
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  /** The seller agent files the document hash (text stays off chain, only keccak256 goes on). */
  async function fileEvidence(index: number) {
    setError(null);
    setPhase("working");
    try {
      const hash = docHash(evidenceText);
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: appChain.id, escrowId: dealId, action: "evidence", index: String(index), evidence: hash }),
      });
      const data = (await res.json()) as { hash?: Hash; error?: string };
      if (!res.ok || !data.hash) throw new Error(data.error ?? "The seller agent refused.");
      await wait(data.hash);
      setNotice(`Proof filed for milestone ${index + 1} (doc hash ${short(hash)}). The response window is now open.`);
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  async function claim(index: number) {
    setError(null);
    setPhase("working");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: appChain.id, escrowId: dealId, action: "claim", index: String(index) }),
      });
      const data = (await res.json()) as { hash?: Hash; error?: string };
      if (!res.ok || !data.hash) throw new Error(data.error ?? "The seller agent refused.");
      await wait(data.hash);
      setNotice(`Milestone ${index + 1} claimed after the response window.`);
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  async function raiseDispute() {
    if (!escrowAddress || !dealId) return;
    setError(null);
    setPhase("working");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "raiseDispute",
        args: [dealId, disputeReason || "No reason given"],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await wait(hash);
      setNotice("Dispute raised. Funds are frozen until the arbiter decides.");
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  async function resolve(toSellerPercent: number) {
    if (!escrowAddress || !dealId || !deal) return;
    setError(null);
    setPhase("working");
    try {
      const unreleased = deal.total - deal.totalReleased;
      const toSeller = (unreleased * BigInt(Math.round(toSellerPercent * 100))) / 10_000n;
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "resolveDispute",
        args: [dealId, toSeller],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await wait(hash);
      setNotice("Dispute resolved: the split is on chain.");
      setPhase("done");
    } catch (e) {
      fail(e);
    }
  }

  function startOver() {
    setDealId(newDealId());
    setPhase("idle");
    setStep(0);
    setError(null);
    setNotice(null);
    setTxHash(null);
    dealQuery.refetch();
  }

  // ---- render helpers -----------------------------------------------------
  const fmt = (v: bigint) => Number(formatUnits(v, token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const dateFmt = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleDateString("en-US", { day: "2-digit", month: "short" });
  const created = deal !== undefined && deal.state !== 0;
  const funded = state === "Funded" || state === "Disputed";
  const canFund = created && state === "Created" && isBuyer;
  const releasedSoFar = deal?.totalReleased ?? 0n;
  const progress = deal && deal.total > 0n ? Number((releasedSoFar * 100n) / deal.total) : 0;

  const ctaCreate = !isConnected
    ? "Connect a wallet to create"
    : !onChain
      ? `Switch to ${appChain.name}`
      : !escrowAddress
        ? "Escrow contract not configured"
        : busy && step === 0
          ? "Check your wallet…"
          : phase === "done" && created
            ? "Create another deal"
            : "Create deal";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExportFlow · Escrow</p>
          <h1>Milestone escrow for a cross-border order</h1>
          <p className="lede">
            The buyer locks stablecoin, the seller ships against milestones, and money only moves on approval, on proof plus a response window, or on an
            arbiter&apos;s decision.
          </p>
        </div>
        <span className={`status-pill ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>
      </div>

      {!escrowAddress && (
        <div className="notice bad" role="alert" style={{ marginTop: 18 }}>
          <strong>Escrow contract missing</strong>
          <span>
            Set <code>NEXT_PUBLIC_ESCROW_{net.key.toUpperCase()}</code> in <code>web/.env.local</code> (see <code>.env.example</code>).
          </span>
        </div>
      )}

      <div className="row" style={{ marginTop: 22 }}>
        {/* ---------------- deal definition ---------------- */}
        <section className="card stack" aria-label="Deal" style={{ flex: "1 1 340px" }}>
          <div className="check-top" style={{ alignItems: "baseline" }}>
            <h2>Deal</h2>
            <span className="mono" style={{ color: "var(--text-muted)" }}>{dealId ? dealLabel(dealId) : "…"}</span>
          </div>

          <label className="stack" style={{ gap: 8 }}>
            <span className="fine">Seller (Rina&apos;s wallet)</span>
            <input className="field" value={String(seller)} onChange={(e) => setSeller(e.target.value)} spellCheck={false} />
          </label>
          <label className="stack" style={{ gap: 8 }}>
            <span className="fine">Arbiter (dispute resolver)</span>
            <input className="field" value={String(arbiter)} onChange={(e) => setArbiter(e.target.value)} spellCheck={false} />
          </label>

          <div className="lines">
            {rows.map((r, i) => (
              <div key={i} className="line" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <span className="fine">{`Milestone ${i + 1} · ${r.label}`}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="field"
                    inputMode="decimal"
                    value={r.amount}
                    aria-label={`Milestone ${i + 1} amount`}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                  <input
                    className="field"
                    style={{ maxWidth: 96 }}
                    inputMode="numeric"
                    value={r.days}
                    aria-label={`Milestone ${i + 1} deadline in days`}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)))}
                  />
                </div>
              </div>
            ))}
            <div className="rule" />
            <div className="line" style={{ alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>Total (computed by the contract)</span>
              <span className="total">
                {fmt(total)} <small>{token.symbol}</small>
              </span>
            </div>
          </div>

          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Escrow</dt>
            <dd>{escrowAddress ? short(escrowAddress) : "not deployed"}</dd>
            <dt>Your {token.symbol}</dt>
            <dd>{balance !== undefined ? fmt(balance) : "—"}</dd>
            <dt>Response window</dt>
            <dd>{windowQuery.data !== undefined ? `${Number(windowQuery.data) / 60} min` : "—"}</dd>
          </dl>

          <button type="button" className="btn big block" disabled={!onChain || !escrowAddress || busy || (created && phase !== "done")} onClick={created ? startOver : createDeal}>
            {created && phase !== "done" ? "Deal already created — start a new one" : ctaCreate}
          </button>
        </section>

        {/* ---------------- funding + milestones ---------------- */}
        <section className="card stack" aria-label="Funding and milestones" style={{ flex: "1.4 1 440px" }}>
          {!created && (
            <div className="notice" role="status" style={{ borderColor: "var(--line-info)", background: "var(--surface-info)", color: "var(--accent-text)" }}>
              <strong>Step 1 · Create the deal first</strong>
              <span>The contract records seller, arbiter, amounts and deadlines, then waits for your funding.</span>
            </div>
          )}

          {created && (
            <>
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>Buyer</dt>
                <dd>
                  {short(deal!.buyer)} {isBuyer ? "· you" : ""}
                </dd>
                <dt>Seller</dt>
                <dd>
                  {short(deal!.seller)} {isSeller ? "· you" : ""}
                </dd>
                <dt>Locked</dt>
                <dd>
                  {fmt(releasedSoFar)} / {fmt(deal!.total)} {token.symbol}
                </dd>
              </dl>
              <div className="progress" aria-hidden="true">
                <span style={{ width: `${progress}%` }} />
              </div>

              {state === "Created" && (
                <div className="modes" role="radiogroup" aria-label="Funding mode">
                  {(
                    [
                      { id: "gasless", title: "Gasless", tag: "EIP-3009", desc: gaslessAvailable ? "Sign once, the relayer pays the gas." : "Relayer off — set RELAYER_PRIVATE_KEY." },
                      { id: "standard", title: "Standard", tag: "approve + fund", desc: "Two wallet transactions, you pay gas." },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      className="mode"
                      aria-checked={mode === m.id}
                      disabled={busy || (m.id === "gasless" && !gaslessAvailable)}
                      onClick={() => setMode(m.id)}
                    >
                      <span className="mode-top">
                        {m.title}
                        <span className="tag">{m.tag}</span>
                      </span>
                      <span className="mode-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>
              )}

              {canFund && (
                <button type="button" className="btn big block" disabled={busy} onClick={fund}>
                  {busy ? (mode === "gasless" ? (step === 0 ? "Check your wallet…" : "Waiting for relayer…") : step === 0 ? "Check your wallet…" : "Confirming…") : `Fund ${fmt(deal!.total)} ${token.symbol}`}
                </button>
              )}
              {created && state === "Created" && !isBuyer && (
                <p className="fine">Only the buyer ({short(deal!.buyer)}) can fund this deal.</p>
              )}

              {/* milestones */}
              {deal!.milestones.length > 0 && (
                <div className="stack" style={{ gap: 0 }}>
                  {deal!.milestones.map((m, i) => {
                    const hasEvidence = m.evidence !== ZERO32;
                    const elapsed = m.evidenceAt > 0n && windowQuery.data !== undefined && BigInt(Math.floor(Date.now() / 1000)) >= m.evidenceAt + windowQuery.data;
                    return (
                      <div className="check" key={i}>
                        <div className={`chip ${m.released ? "ok" : hasEvidence ? "warn" : "idle"}`}>{m.released ? <CheckIcon /> : i + 1}</div>
                        <div className="check-body">
                          <div className="check-top">
                            <span className="check-title">{rows[i]?.label ?? `Milestone ${i + 1}`}</span>
                            <span className="check-value">
                              {fmt(m.amount)} {token.symbol}
                            </span>
                          </div>
                          <p className="check-detail">
                            {m.released ? "Released to the seller" : `Deadline ${dateFmt(m.deadline)} · ${hasEvidence ? `proof ${short(m.evidence)} filed` : "no proof yet"}`}
                          </p>
                          {!m.released && state === "Funded" && (
                            <div className="check-action" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {isBuyer && (
                                <button type="button" className="btn small" disabled={busy} onClick={() => approve(i)}>
                                  Approve &amp; release
                                </button>
                              )}
                              {agent.data?.enabled && (
                                <>
                                  {!hasEvidence && (
                                    <button type="button" className="btn small secondary" disabled={busy} onClick={() => fileEvidence(i)}>
                                      Seller agent: file proof
                                    </button>
                                  )}
                                  {hasEvidence && (
                                    <button type="button" className="btn small secondary" disabled={busy || !elapsed} onClick={() => claim(i)} title={elapsed ? "" : "The buyer's response window is still open"}>
                                      Seller agent: claim{!elapsed ? " (window open)" : ""}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {(state === "Funded" || state === "Disputed") && (
                <div className="rule" />
              )}

              {/* dispute */}
              {state === "Funded" && (isBuyer || isSeller) && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="fine">Something wrong? Freeze the deal for the arbiter.</span>
                  <input className="field" placeholder="Reason (on chain, keep it short)" value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} />
                  <button type="button" className="btn warn block" disabled={busy} onClick={raiseDispute}>
                    Raise dispute
                  </button>
                </div>
              )}

              {state === "Disputed" && isArbiter && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="fine">Arbiter: split what hasn&apos;t been released (to seller / to buyer).</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {[100, 70, 50, 30, 0].map((p) => (
                      <button key={p} type="button" className="btn small secondary" disabled={busy} onClick={() => resolve(p)}>
                        {p}/{100 - p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="notice bad" role="alert">
              <strong>Transaction didn&apos;t go through</strong>
              <span>{error}</span>
            </div>
          )}
          {notice && !error && (
            <div className="notice good" role="status">
              <div className="row-between">
                <strong>{notice}</strong>
                {txHash && hasExplorer && (
                  <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                )}
              </div>
            </div>
          )}
          {!agent.data?.enabled && (
            <p className="fine">
              Seller-agent buttons appear when <code>RINA_PRIVATE_KEY</code> is set (demo counterparty, testnet only).
            </p>
          )}
        </section>
      </div>

      {/* ---------------- seller agent document ---------------- */}
      {created && (
        <section className="card stack" aria-label="Seller proof document" style={{ marginTop: 24 }}>
          <h2>Proof document (seller agent)</h2>
          <p className="sub">
            The text never goes on chain — only <code>keccak256</code> of the normalized document. Any later reader can re-hash the file and compare.
          </p>
          <textarea className="field" rows={7} style={{ minHeight: 140, resize: "vertical", lineHeight: 1.5 }} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} />
          <p className="fine mono">hash: {evidenceText ? docHash(evidenceText) : "—"}</p>
        </section>
      )}
    </main>
  );
}
