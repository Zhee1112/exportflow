import { NextResponse } from "next/server";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  parseSignature,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { aevumFork, checkoutAbi, isAnvilAccount, localAnvil, TUSD8_DECIMALS } from "@aevum-kit/aevum";
import { defaultNetwork, networkByChainId, type Network } from "@/lib/env";
import { explain } from "@/lib/errors";
import { escrowAbi } from "@/lib/exportflow";
import { clientIp, overLimit } from "@/lib/ratelimit";
import { priceOf } from "@/lib/order";

/**
 * The relayer behind "Gasless" checkout and "Gasless" escrow funding. The buyer only
 * signs; this route submits Checkout.payWithAuthorization or Escrow.fundWithAuthorization
 * and pays the gas from RELAYER_PRIVATE_KEY.
 *
 * Anyone on the internet can call this route, and every transaction it sends costs YOUR gas.
 * The rails, in the order they run:
 *  1. Only YOUR contracts, only payWithAuthorization / fundWithAuthorization. It never
 *     forwards arbitrary calls.
 *  2. Only the price your app set for that order (priceOf) — or, for the escrow, the total
 *     read back from the chain itself. Dust payments to burn gas are refused.
 *  3. Not already paid, and not already being submitted.
 *  4. Simulated first, so a bad or expired signature costs nothing.
 *  5. Rate limits per IP and per payer, and a daily cap on transactions.
 *
 * The limits below live in this process's memory. That's fine for `next start` on one server.
 * On serverless (Vercel, Netlify…) every instance has its own copy and loses it on a cold start:
 * move them to a shared store (Redis, Upstash, your database) before you rely on them.
 */
export const runtime = "nodejs";

const MAX_WINDOW_SECONDS = 3600n;
const PER_IP_PER_MINUTE = 10;
const PER_PAYER_PER_MINUTE = 3;
const DAILY_TX_LIMIT = Number(process.env.RELAYER_DAILY_TX_LIMIT ?? 500);
const IN_FLIGHT_MS = 120_000;
const LOCAL_CHAINS = new Set<number>([localAnvil.id, aevumFork.id]);
const isDev = process.env.NODE_ENV !== "production";

// One account for the whole process, so viem's nonce manager can hand out nonces to
// concurrent requests without two transactions colliding.
let cachedAccount: PrivateKeyAccount | null | undefined;
function relayer(): PrivateKeyAccount | undefined {
  if (cachedAccount !== undefined) return cachedAccount ?? undefined;
  const raw = process.env.RELAYER_PRIVATE_KEY?.trim();
  const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
  cachedAccount = raw && isHex(key) && key.length === 66 ? privateKeyToAccount(key, { nonceManager }) : null;
  return cachedAccount ?? undefined;
}

/** anvil's default keys are public. On a real network, bots would empty that relayer in seconds. */
function usable(account: PrivateKeyAccount | undefined, net: Network): PrivateKeyAccount | undefined {
  if (!account) return undefined;
  if (isAnvilAccount(account.address) && !LOCAL_CHAINS.has(net.chain.id)) return undefined;
  return account;
}

// ---- per-IP limits (shared helper; see the note at the top) ----
let day = "";
let sentToday = 0;
function overDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  return sentToday >= DAILY_TX_LIMIT;
}

const inFlight = new Map<string, number>();
function claimInFlight(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_MS) inFlight.delete(k);
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** The configured network a request is for. No chainId means the default network. */
function networkFor(chainId: unknown): Network | undefined {
  if (chainId === undefined || chainId === null || chainId === "") return defaultNetwork;
  return networkByChainId(Number(chainId));
}

/** GET /api/relay?chainId=… tells the app whether gasless mode is available on that network. */
export async function GET(req: Request) {
  const net = networkFor(new URL(req.url).searchParams.get("chainId"));
  const account = net ? usable(relayer(), net) : undefined;
  const canPay = Boolean(account && (net?.checkout || net?.escrow));
  return NextResponse.json({ enabled: canPay, relayer: account?.address ?? null });
}

export async function POST(req: Request) {
  if (overLimit(`ip:${clientIp(req)}`, PER_IP_PER_MINUTE)) return fail("Too many requests. Wait a minute.", 429);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON.");
  }

  // Only networks the app is configured for, and only their own contracts.
  const net = networkFor(body.chainId);
  if (!net) return fail("This network isn't enabled in the app.");
  const account = usable(relayer(), net);
  const action = body.action === "fundEscrow" ? "fundEscrow" : "pay";
  const contract = action === "fundEscrow" ? net.escrow : net.checkout;
  if (!account || !contract) {
    // Which settings are missing is useful while you build, and nobody else's business once deployed.
    const varName = action === "fundEscrow" ? `NEXT_PUBLIC_ESCROW_${net.key.toUpperCase()}` : `NEXT_PUBLIC_CHECKOUT_${net.key.toUpperCase()}`;
    return fail(
      isDev
        ? `Gasless mode is off on ${net.label}. Set RELAYER_PRIVATE_KEY (not an anvil key, except on local chains) and ${varName} in web/.env.local.`
        : "Gasless mode isn't available right now. Use Standard mode.",
      503,
    );
  }

  const { from, validAfter, validBefore, signature } = body;
  if (
    !(typeof from === "string" && isAddress(from)) ||
    !isUint(validAfter) || !isUint(validBefore) ||
    !(typeof signature === "string" && isHex(signature))
  ) {
    return fail("Malformed payment request.");
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(validBefore) > now + MAX_WINDOW_SECONDS) return fail("Signature window is too long (max 1 hour).");
  if (overLimit(`payer:${from.toLowerCase()}`, PER_PAYER_PER_MINUTE)) return fail("Too many payments from this address. Wait a minute.", 429);

  let v: bigint | undefined, r: Hex, s: Hex, yParity: number | undefined;
  try {
    ({ v, r, s, yParity } = parseSignature(signature));
  } catch {
    return fail("Invalid signature.");
  }
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);

  const transport = http();
  const client = createPublicClient({ chain: net.chain, transport });
  const wallet = createWalletClient({ account, chain: net.chain, transport });

  // What this call is allowed to spend comes from OUR app (priceOf) or from the chain itself
  // (the escrow's own total) — never from the request body.
  let flightKey: string;
  /** Reads whatever it must (paid flag / deal state+total), so nothing trusting happens client-side. */
  let ready: () => Promise<void>;
  let buildCall: () => Record<string, unknown>;

  if (action === "fundEscrow") {
    const { escrowId } = body;
    if (!(typeof escrowId === "string" && isHex(escrowId) && escrowId.length === 66)) return fail("Malformed escrow id.");
    flightKey = `${net.chain.id}:fund:${escrowId.toLowerCase()}`;
    ready = async () => {
      const deal = (await client.readContract({ address: contract, abi: escrowAbi, functionName: "dealOf", args: [escrowId] })) as {
        buyer: Address;
        state: number;
      };
      if (deal.buyer.toLowerCase() !== from.toLowerCase()) throw new Error("This escrow belongs to another buyer.");
      if (deal.state !== 1) throw new Error("This escrow isn't waiting for funding."); // only Created can be funded
    };
    buildCall = () => ({
      account,
      address: contract,
      abi: escrowAbi,
      functionName: "fundWithAuthorization",
      args: [escrowId, BigInt(validAfter), BigInt(validBefore), vNum, r, s],
    });
  } else {
    const { orderId, amount: rawAmount } = body;
    if (!(typeof orderId === "string" && isHex(orderId) && orderId.length === 66) || !isUint(rawAmount)) {
      return fail("Malformed payment request.");
    }
    if (BigInt(rawAmount) !== parseUnits(priceOf(orderId), TUSD8_DECIMALS)) return fail("The amount doesn't match this order's price.");
    const amount = BigInt(rawAmount);
    flightKey = `${net.chain.id}:${orderId.toLowerCase()}`;
    ready = async () => {
      if (await client.readContract({ address: contract, abi: checkoutAbi, functionName: "isPaid", args: [orderId] })) {
        throw new Error("This order is already paid. Start a new order.");
      }
    };
    buildCall = () => ({
      account,
      address: contract,
      abi: checkoutAbi,
      functionName: "payWithAuthorization",
      args: [orderId, from, amount, BigInt(validAfter), BigInt(validBefore), vNum, r, s],
    });
  }

  if (!claimInFlight(flightKey)) return fail("This payment is already being submitted.", 409);
  try {
    await ready();
    if (overDailyLimit()) {
      inFlight.delete(flightKey);
      return fail("The relayer reached its daily limit. Use Standard mode.", 503);
    }

    // The ABI differs per action; viem only needs the right object at runtime.
    const call = buildCall();
    await client.simulateContract(call as never);
    const hash = await wallet.writeContract({ ...call, type: "legacy" } as never);
    sentToday++;
    return NextResponse.json({ hash });
  } catch (e) {
    inFlight.delete(flightKey);
    // Out of gas here means the RELAYER is out of gas, not the buyer.
    if (e instanceof BaseError && /insufficient funds/i.test(e.message)) {
      console.error("[relay] relayer is out of gas", account.address);
      return fail("The relayer is out of gas. Use Standard mode for now.", 503);
    }
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("another buyer") || msg.includes("isn't waiting")) return fail(msg, 409);
    return fail(explain(e));
  }
}
