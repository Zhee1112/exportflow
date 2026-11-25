"use client";

import { erc20Abi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { createWalletClient, formatUnits, http, parseUnits, toFunctionSelector, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, useConfig, useReadContract, useReadContracts, useSendTransaction } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { docHash, SAMPLE_PO } from "@/lib/doc";
import { DEMO_SELLER, docRegistryAbi, sessionPolicyAbi, short } from "@/lib/exportflow";
import { explain } from "@/lib/errors";
import { useNetwork } from "@/lib/network";

const REGISTER_SELECTOR = toFunctionSelector("register(bytes32,address)");

/** What the hot key is allowed to do: anchor document hashes, and nothing on the escrow. */
const ALLOWED_TARGET_LABEL = "DocRegistry.register(bytes32,address)";

export default function SessionPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const policyAddress = net.sessionPolicy;
  const registry = net.docRegistry;
  const token = useToken();
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const { sendTransactionAsync } = useSendTransaction();

  const [maxCalls, setMaxCalls] = useState("3");
  const [minutes, setMinutes] = useState("10");
  const [spendCap, setSpendCap] = useState("5.00");
  const [gasFloat, setGasFloat] = useState("0.01");

  const [sessionId, setSessionId] = useState<Hex | null>(null);
  const [delegateKey, setDelegateKey] = useState<Hex | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const delegate = useMemo(() => (delegateKey ? privateKeyToAccount(delegateKey) : null), [delegateKey]);

  const session = useReadContract({
    address: policyAddress,
    abi: sessionPolicyAbi,
    functionName: "sessionOf",
    args: sessionId ? [sessionId] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(policyAddress && sessionId), refetchInterval: 6_000 },
  });
  const s = session.data?.[0];
  const active = Boolean(s?.active);

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: delegate ? [delegate.address] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(token.address && delegate) },
  });

  const relayStatus = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () => (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean }>,
  });

  const note = useCallback((line: string) => setLog((l) => [`${new Date().toLocaleTimeString("en-GB", { hour12: false })} · ${line}`, ...l].slice(0, 8)), []);

  async function wait(hash: Hash) {
    await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
    setLastTx(hash);
    session.refetch();
    balance.refetch();
    reads.refetch();
    return hash;
  }

  const reads = useReadContracts({
    contracts: [
      { address: token.address, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: appChain.id },
      { address: token.address, abi: erc20Abi, functionName: "allowance", args: address && policyAddress ? [address, policyAddress] : undefined, chainId: appChain.id },
    ],
    query: { enabled: Boolean(token.address && policyAddress && address) },
  });
  const ownerBalance = reads.data?.[0]?.result;
  const allowance = reads.data?.[1]?.result;

  /** 1) Owner grants the session key: generate a fresh key, scope it, fund its gas, set the cap. */
  async function grant() {
    if (!address || !policyAddress) return;
    setError(null);
    setLastTx(null);
    setBusy(true);
    try {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const cap = parseUnits(spendCap || "0", token.decimals);
      const targets: Address[] = registry ? [registry] : [];
      if (!targets.length) throw new Error("DocRegistry not configured on this network.");
      const { request } = await simulateContract(config, {
        account: address,
        address: policyAddress,
        abi: sessionPolicyAbi,
        functionName: "createSession",
        args: [account.address, targets, [REGISTER_SELECTOR], Number(maxCalls || "1"), now, now + BigInt(minutes || "10") * 60n, token.address!, cap],
        chainId: appChain.id,
      });
      const id = (await writeContract(config, request)) as Hex;
      const receipt = await waitForTransactionReceipt(config, { hash: id, chainId: appChain.id });
      // SessionCreated has sessionId as its first indexed topic.
      const created = receipt.logs.find((l) => l.address.toLowerCase() === policyAddress.toLowerCase());
      const sid = created?.topics[1] as Hex | undefined;
      if (!sid) throw new Error("Session created but its id wasn't found in the logs.");
      setSessionId(sid);
      setDelegateKey(key);
      setOwner(address);
      note(`session granted to ${short(account.address)} · ${maxCalls} calls · ${minutes} min · cap ${spendCap} ${token.symbol}`);

      // 2) gas float so the hot key can send transactions (testnet tQDAY)
      const gasHash = await sendTransactionAsync({ to: account.address, value: parseUnits(gasFloat || "0.01", 18), chainId: appChain.id });
      await wait(gasHash);
      note(`sent ${gasFloat} tQDAY gas float to ${short(account.address)}`);

      // 3) approve the policy for exactly the cap (never unlimited)
      if (cap > 0n && (allowance ?? 0n) < cap) {
        const approveHash = await writeContract(config, {
          address: token.address!,
          abi: erc20Abi,
          functionName: "approve",
          args: [policyAddress, cap],
          chainId: appChain.id,
        });
        await wait(approveHash);
        note(`approved the policy for ${spendCap} ${token.symbol} (exact cap)`);
      }
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  /** Any transaction the DEMO hot key signs. Its private key never leaves this tab. */
  async function agentWrite(fnName: "execute" | "spend", args: readonly unknown[]): Promise<Hash> {
    if (!delegate || !sessionId || !policyAddress) throw new Error("Grant a session key first.");
    const wallet = createWalletClient({ account: delegate, chain: appChain, transport: http() });
    const hash = await wallet.writeContract({
      address: policyAddress,
      abi: sessionPolicyAbi,
      functionName: fnName,
      args: args as never,
    });
    return wait(hash);
  }

  /** 4a) Agent anchors a document hash — allowed target+selector. */
  async function agentAnchor() {
    setError(null);
    setBusy(true);
    try {
      if (!registry || !owner) throw new Error("Registry not configured.");
      // DocRegistry.register(docHash, declaredOwner), wrapped in policy.execute
      const hash32 = docHash(SAMPLE_PO);
      const data = (`0x${toFunctionSelector("register(bytes32,address)").slice(2)}${hash32.slice(2).padStart(64, "0")}${owner.slice(2).padStart(64, "0")}`) as Hex;
      const hash = await agentWrite("execute", [sessionId!, registry, data]);
      setLastTx(hash);
      note(`agent anchored doc ${short(hash32)} via the policy (allowed call) ✓`);
    } catch (e) {
      const msg = explain(e);
      setError(msg);
      note(`agent blocked: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  /** 4b) Agent pays the supplier inside its cap. */
  async function agentSpend(amount: string) {
    setError(null);
    setBusy(true);
    try {
      const hash = await agentWrite("spend", [sessionId!, DEMO_SELLER, parseUnits(amount, token.decimals)]);
      setLastTx(hash);
      note(`agent paid ${amount} ${token.symbol} to Rina inside its cap ✓`);
    } catch (e) {
      const msg = explain(e);
      setError(msg);
      note(`agent blocked: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  /** 4c) Agent tries something outside its scope — must fail. */
  async function agentOverreach() {
    setError(null);
    setBusy(true);
    try {
      if (!registry) throw new Error("Registry not configured.");
      // an unallowlisted selector on an allowlisted target (claim instead of register)
      const data = `0x${toFunctionSelector("claim(bytes32)").slice(2)}${"0".repeat(64)}` as Hex;
      const hash = await agentWrite("execute", [sessionId!, registry, data]);
      setLastTx(hash);
      note("UNEXPECTED: the agent was allowed outside its scope!");
    } catch (e) {
      const msg = explain(e);
      setError(null);
      note(`agent blocked by policy: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  /** 5) Owner revokes instantly. */
  async function revoke() {
    if (!address || !policyAddress || !sessionId) return;
    setError(null);
    setBusy(true);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: policyAddress,
        abi: sessionPolicyAbi,
        functionName: "revokeSession",
        args: [sessionId],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await wait(hash);
      note("session revoked by the owner — the hot key is dead ✓");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  const fmt = (v: bigint | undefined) => (v === undefined ? "—" : Number(formatUnits(v, token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 }));

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExportFlow · Session keys</p>
          <h1>Give the agent a key that can&apos;t betray you</h1>
          <p className="lede">
            A hot key for the document agent: it may only call <code>DocRegistry.register</code>, only for the next N minutes, at most N calls, and spend up to a
            stablecoin cap you set. The owner revokes it in one transaction — no key rotation, no waiting.
          </p>
        </div>
        <span className={`status-pill ${active ? "good" : sessionId ? "warn" : "warn"}`}>{sessionId ? (active ? "session active" : "revoked") : "no session yet"}</span>
      </div>

      {!policyAddress && (
        <div className="notice bad" role="alert" style={{ marginTop: 18 }}>
          <strong>SessionPolicy contract missing</strong>
          <span>
            Set <code>NEXT_PUBLIC_SESSION_POLICY_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
          </span>
        </div>
      )}

      <div className="row" style={{ marginTop: 22 }}>
        {/* ------------- owner side ------------- */}
        <section className="card stack" aria-label="Grant session" style={{ flex: "1 1 340px" }}>
          <h2>1 · Owner grants</h2>
          <p className="sub">Runs in your wallet. The hot key is generated in this tab and never uploaded.</p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">Max calls</span>
              <input className="field" inputMode="numeric" value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">Valid (min)</span>
              <input className="field" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">Spend cap</span>
              <input className="field" inputMode="decimal" value={spendCap} onChange={(e) => setSpendCap(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">Gas float (tQDAY)</span>
              <input className="field" inputMode="decimal" value={gasFloat} onChange={(e) => setGasFloat(e.target.value)} />
            </label>
          </div>

          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Allowlist</dt>
            <dd>{ALLOWED_TARGET_LABEL}</dd>
            <dt>Your {token.symbol}</dt>
            <dd>{fmt(ownerBalance)}</dd>
            <dt>Relayer</dt>
            <dd>{relayStatus.data?.enabled ? "on" : "off (not needed here)"}</dd>
          </dl>

          <button type="button" className="btn big block" disabled={!onChain || !policyAddress || busy || !isConnected} onClick={grant}>
            {busy && !sessionId ? "Check your wallet…" : sessionId ? "Grant another session" : "Grant session key"}
          </button>
          {!isConnected && <p className="fine">Connect a wallet to grant a session.</p>}
        </section>

        {/* ------------- delegate side ------------- */}
        <section className="card stack" aria-label="Agent actions" style={{ flex: "1.3 1 420px" }}>
          <div className="check-top" style={{ alignItems: "baseline" }}>
            <h2>2 · Agent acts</h2>
            <span className="mono" style={{ color: "var(--text-muted)" }}>
              {sessionId ? `#${sessionId.slice(2, 6).toUpperCase()}-${sessionId.slice(-4).toUpperCase()}` : "…"}
            </span>
          </div>

          {!sessionId && (
            <div className="notice" role="status" style={{ borderColor: "var(--line-info)", background: "var(--surface-info)", color: "var(--accent-text)" }}>
              <strong>Grant a session first</strong>
              <span>Then the hot key runs inside its cage: right target, right selector, right time, right budget.</span>
            </div>
          )}

          {sessionId && s && (
            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Hot key</dt>
              <dd>{delegate ? `${short(delegate.address)} ${balance.data !== undefined ? `· ${fmt(balance.data)} tQDAY` : ""}` : "—"}</dd>
              <dt>Calls used</dt>
              <dd>
                {Number(s.callsUsed)} / {Number(s.maxCalls)}
              </dd>
              <dt>Spent</dt>
              <dd>
                {fmt(s.spent)} / {fmt(s.spendCap)} {token.symbol}
              </dd>
              <dt>Owner</dt>
              <dd>{owner ? short(owner) : "—"}</dd>
            </dl>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn" disabled={!active || busy || !registry} onClick={agentAnchor}>
              Agent: anchor a doc hash
            </button>
            <button type="button" className="btn secondary" disabled={!active || busy} onClick={() => agentSpend("1")}>
              Agent: pay supplier 1 {token.symbol}
            </button>
            <button type="button" className="btn warn" disabled={!active || busy} onClick={() => agentSpend("6")}>
              Agent: try to spend 6 (over cap)
            </button>
            <button type="button" className="btn warn" disabled={!active || busy} onClick={agentOverreach}>
              Agent: try an unlisted call
            </button>
            <button type="button" className="btn ghost" disabled={!sessionId || !active || busy} onClick={revoke}>
              Owner: revoke session
            </button>
          </div>

          {error && (
            <div className="notice bad" role="alert">
              <strong>Blocked</strong>
              <span>{error}</span>
            </div>
          )}
          {lastTx && net.hasExplorer && (
            <p className="fine">
              <a href={txUrl(lastTx)} target="_blank" rel="noreferrer">
                Last transaction on explorer
              </a>
            </p>
          )}

          <div className="stack" style={{ gap: 6 }}>
            <span className="fine">Session log</span>
            {log.length === 0 && <p className="fine">Actions appear here.</p>}
            {log.map((l, i) => (
              <span key={i} className="mono" style={{ fontSize: 12, color: i === 0 ? "var(--text)" : "var(--text-muted)" }}>
                {l}
              </span>
            ))}
          </div>
        </section>
      </div>

      <section className="card stack" aria-label="Policy explanation" style={{ marginTop: 24 }}>
        <h2>What the contract enforces</h2>
        <ul>
          <li>
            <strong>Target + selector allowlist</strong> — the hot key can call {ALLOWED_TARGET_LABEL} and nothing else; the escrow and every other contract are
            invisible to it.
          </li>
          <li>
            <strong>Call budget</strong> — after {maxCalls} calls (including spends) the session reverts with <code>CallLimitReached</code>.
          </li>
          <li>
            <strong>Stablecoin cap</strong> — cumulative spending above {spendCap} {token.symbol} reverts with <code>SpendCapExceeded</code>; the approval given to
            the policy is exactly that cap, never unlimited.
          </li>
          <li>
            <strong>Expiry + revocation</strong> — the session dies at its deadline (<code>SessionExpired</code>) or the moment the owner calls{" "}
            <code>revokeSession</code> (<code>SessionInactive</code>).
          </li>
          <li>
            <strong>No custody</strong> — the policy holds no funds; the cap is enforced against the owner&apos;s own allowance.
          </li>
        </ul>
        <p className="fine">
          Aevum testnet has no supported bundler/paymanster yet (challenge FAQ), so this contract-based session layer is the integration path today; the same
          limits map onto native session keys when the bundler lands.
        </p>
      </section>
    </main>
  );
}
