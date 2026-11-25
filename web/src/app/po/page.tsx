"use client";

import { txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { Hash } from "viem";
import { useAccount, useConfig } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { docHash, normalizeDoc, SAMPLE_PO, SAMPLE_PO_INJECTED, type PoFields, type PoResult } from "@/lib/doc";
import { docRegistryAbi, short } from "@/lib/exportflow";
import { explain } from "@/lib/errors";
import { useNetwork } from "@/lib/network";

export default function PoPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const registry = net.docRegistry;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;

  const [text, setText] = useState(SAMPLE_PO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PoResult | null>(null);
  const [anchorTx, setAnchorTx] = useState<Hash | null>(null);

  const hash = docHash(text);

  async function read() {
    setError(null);
    setResult(null);
    setAnchorTx(null);
    setBusy(true);
    try {
      const res = await fetch("/api/po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as PoResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "The reader couldn't parse this document.");
      setResult({ ...data, hash, normalized: normalizeDoc(text) });
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  async function anchor() {
    if (!registry || !address) return;
    setError(null);
    setBusy(true);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: registry,
        abi: docRegistryAbi,
        functionName: "register",
        args: [hash, address],
        chainId: appChain.id,
      });
      const tx = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash: tx, chainId: appChain.id });
      setAnchorTx(tx);
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  const fields: PoFields | undefined = result?.fields;
  const readerMode = useQuery({
    queryKey: ["po-mode"],
    queryFn: async () => (await fetch("/api/po")).json() as Promise<{ mode: string }>,
  });

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExportFlow · AI document agent</p>
          <h1>Purchase-order reader</h1>
          <p className="lede">
            Paste a PO: the agent extracts the commercial fields, scans for prompt injection, and can anchor the document hash on chain — the numbers never
            become an action without you pressing the button.
          </p>
        </div>
        <span className="status-pill warn">reader: {readerMode.data?.mode ?? "…"}</span>
      </div>

      <div className="row" style={{ marginTop: 22 }}>
        <section className="card stack" aria-label="Document" style={{ flex: "1 1 340px" }}>
          <div className="check-top" style={{ alignItems: "baseline" }}>
            <h2>Document</h2>
            <span className="mono" style={{ color: "var(--text-muted)" }}>
              {short(hash)}
            </span>
          </div>
          <textarea
            className="field"
            rows={14}
            style={{ minHeight: 260, resize: "vertical", lineHeight: 1.55 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Purchase order text"
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn small secondary" onClick={() => setText(SAMPLE_PO)}>
              Load clean PO
            </button>
            <button type="button" className="btn small warn" onClick={() => setText(SAMPLE_PO_INJECTED)}>
              Load PO with injection
            </button>
          </div>
          <button type="button" className="btn big block" disabled={busy || !text.trim()} onClick={read}>
            {busy ? "Reading…" : "Read purchase order"}
          </button>
          <p className="fine">
            Hash = <code>keccak256</code> of the normalized text (NFC, LF, trimmed) — both trading sides can recompute it later.
          </p>
        </section>

        <section className="card stack" aria-label="Extraction" style={{ flex: "1.3 1 420px" }}>
          {!result && !error && (
            <div className="notice" role="status" style={{ borderColor: "var(--line-info)", background: "var(--surface-info)", color: "var(--accent-text)" }}>
              <strong>Waiting for a document</strong>
              <span>Fields, warnings and the on-chain anchor appear here. Try the injected sample to see the guard rails.</span>
            </div>
          )}

          {error && (
            <div className="notice bad" role="alert">
              <strong>The reader stopped</strong>
              <span>{error}</span>
            </div>
          )}

          {result && (
            <>
              {result.warnings.length > 0 && (
                <div className="notice bad" role="alert">
                  <strong>Prompt injection / tamper signals detected</strong>
                  {result.warnings.map((w) => (
                    <span key={w}>• {w}</span>
                  ))}
                  <span>The agent treated the document as data only: no instruction in it was followed, and nothing was submitted on chain.</span>
                </div>
              )}
              {result.warnings.length === 0 && (
                <div className="notice good" role="status">
                  <div className="row-between">
                    <strong>Clean read · no injection signals</strong>
                    <span className="fine">source: {result.source === "model" ? "model (verified scan)" : "deterministic parser"}</span>
                  </div>
                </div>
              )}

              <div className="lines">
                <div className="line">
                  <span>PO number</span>
                  <span className="mono">{fields?.poNumber || "—"}</span>
                </div>
                <div className="line">
                  <span>Supplier</span>
                  <span className="mono">{fields?.supplier || "—"}</span>
                </div>
                <div className="line">
                  <span>Buyer</span>
                  <span className="mono">{fields?.buyer || "—"}</span>
                </div>
                <div className="line">
                  <span>Incoterm</span>
                  <span className="mono">{fields?.incoterm || "—"}</span>
                </div>
                <div className="line">
                  <span>Delivery</span>
                  <span className="mono">{fields?.deliveryDate || "—"}</span>
                </div>
                <div className="rule" />
                {fields?.items.map((i, n) => (
                  <div className="line" key={n}>
                    <span>
                      {i.description} <span className="fine">× {i.qty} @ {i.unitPrice}</span>
                    </span>
                    <span className="num mono">{i.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                  </div>
                ))}
                <div className="rule" />
                <div className="line" style={{ alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600 }}>Total</span>
                  <span className="total">
                    {fields?.total.toLocaleString("en-US", { minimumFractionDigits: 2 })} <small>{fields?.currency}</small>
                  </span>
                </div>
              </div>

              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>Doc hash</dt>
                <dd>{result.hash}</dd>
                <dt>Registry</dt>
                <dd>{registry ? short(registry) : "not deployed"}</dd>
              </dl>

              <button type="button" className="btn big block" disabled={!onChain || !registry || busy || Boolean(anchorTx)} onClick={anchor}>
                {anchorTx ? "Anchored on chain ✓" : isConnected ? (onChain ? "Anchor hash on DocRegistry" : `Switch to ${appChain.name}`) : "Connect wallet to anchor"}
              </button>
              {anchorTx && net.hasExplorer && (
                <p className="fine">
                  <a href={txUrl(anchorTx)} target="_blank" rel="noreferrer">
                    View registration
                  </a>{" "}
                  · the registry proves this exact text existed now, without publishing it.
                </p>
              )}
              <p className="fine">
                Next: create the escrow in <Link href="/trade">Trade</Link> and file the same hash as milestone proof.
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
