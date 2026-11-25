import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isHex, type Address, type Hex } from "viem";
import { isAnvilAccount } from "@aevum-kit/aevum";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { defaultNetwork, networkByChainId, type Network } from "@/lib/env";
import { explain } from "@/lib/errors";
import { escrowAbi } from "@/lib/exportflow";

/**
 * The seller's agent (demo counterparty "Rina"). The buyer's wallet lives in the browser;
 * the seller is a server-side agent so a single person can run the whole live demo.
 *
 * It only ever signs Escrow calls that the SELLER address is allowed to make:
 *   evidence — submitEvidence (hash of a shipping document, text never stored on chain)
 *   claim    — claimAfterDeadline (after the response window, if the buyer went silent)
 * Anything else is refused before a transaction exists, and every call is simulated first.
 *
 * Testnet demo only. In production this agent would hold its own key in an HSM/KMS and the
 * document text in private storage; RINA_PRIVATE_KEY must never be a real wallet.
 */
export const runtime = "nodejs";

const isDev = process.env.NODE_ENV !== "production";
const LOCAL_CHAINS = new Set<number>([31337]);
const ACTIONS = new Set(["evidence", "claim"]);

// Minimal in-memory rate limit (same note as /api/relay: one process only).
const hits = new Map<string, number[]>();
function limited(bucket: string, max = 8): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  return recent.length > max;
}

function sellerAccount(net: Network) {
  const raw = process.env.RINA_PRIVATE_KEY?.trim();
  const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
  if (!raw || !isHex(key) || key.length !== 66) return undefined;
  const account = privateKeyToAccount(key, { nonceManager });
  // Anvil's default keys are public; never run them on a shared network.
  if (isAnvilAccount(account.address) && !LOCAL_CHAINS.has(net.chain.id)) return undefined;
  return account;
}

function networkFor(chainId: unknown): Network | undefined {
  if (chainId === undefined || chainId === null || chainId === "") return defaultNetwork;
  return networkByChainId(Number(chainId));
}

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,4}$/.test(v);
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** GET /api/agent — is the seller agent available, and which address does it sign as? */
export async function GET(req: Request) {
  const net = networkFor(new URL(req.url).searchParams.get("chainId"));
  const account = net ? sellerAccount(net) : undefined;
  return NextResponse.json({ enabled: Boolean(account && net?.escrow), seller: account?.address ?? null });
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  if (limited(`ip:${ip}`)) return fail("Too many requests. Wait a minute.", 429);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON.");
  }

  const net = networkFor(body.chainId);
  if (!net?.escrow) return fail("The seller agent isn't configured for this network.", 503);
  const account = sellerAccount(net);
  if (!account) {
    return fail(
      isDev ? "Set RINA_PRIVATE_KEY (a throwaway testnet key) in web/.env.local to enable the seller agent." : "The seller agent isn't available right now.",
      503,
    );
  }

  const { escrowId, action, index, evidence } = body;
  if (!(typeof escrowId === "string" && isHex(escrowId) && escrowId.length === 66)) return fail("Malformed escrow id.");
  if (typeof action !== "string" || !ACTIONS.has(action)) return fail("Unknown agent action.");
  if (action === "evidence" && !(typeof evidence === "string" && isHex(evidence) && evidence.length === 66)) return fail("Malformed evidence hash.");
  if (!isUint(index)) return fail("Malformed milestone index.");

  const transport = http();
  const client = createPublicClient({ chain: net.chain, transport });
  const wallet = createWalletClient({ account, chain: net.chain, transport });

  try {
    const deal = await client.readContract({ address: net.escrow, abi: escrowAbi, functionName: "dealOf", args: [escrowId] });
    if (deal.seller.toLowerCase() !== account.address.toLowerCase()) {
      return fail("This deal's seller isn't this agent's address.", 409);
    }
    if (deal.state !== 2) return fail("The deal isn't funded, so the seller can't act yet.", 409);

    const ms = deal.milestones[Number(index)];
    if (!ms) return fail("No such milestone.", 404);
    if (ms.released) return fail("That milestone is already released.", 409);

    let call: Record<string, unknown>;
    if (action === "evidence") {
      if (ms.evidence !== ("0x" + "0".repeat(64)) as Hex) return fail("Proof for that milestone is already filed.", 409);
      call = {
        account,
        address: net.escrow,
        abi: escrowAbi,
        functionName: "submitEvidence",
        args: [escrowId, BigInt(index), evidence],
      };
    } else {
      if (ms.evidence === ("0x" + "0".repeat(64)) as Hex) return fail("File proof first — a claim needs evidence on chain.", 409);
      const window = (await client.readContract({ address: net.escrow, abi: escrowAbi, functionName: "responseWindow" })) as bigint;
      if (BigInt(Math.floor(Date.now() / 1000)) < ms.evidenceAt + window) {
        return fail("The buyer's response window is still open. Wait for it to pass.", 409);
      }
      call = {
        account,
        address: net.escrow,
        abi: escrowAbi,
        functionName: "claimAfterDeadline",
        args: [escrowId, BigInt(index)],
      };
    }

    await client.simulateContract(call as never);
    const hash = await wallet.writeContract({ ...call, type: "legacy" } as never);
    return NextResponse.json({ hash, seller: account.address });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/isn't funded|No such milestone|already filed|response window|File proof|already released|seller isn't/i.test(msg)) return fail(msg, 409);
    return fail(explain(e));
  }
}
