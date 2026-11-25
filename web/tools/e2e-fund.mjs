// End-to-end smoke test against Aevum TESTNET. Creates a deal, funds it gaslessly through
// the same /api/relay route the UI uses, then releases milestone 1. Run with the dev server up:
//
//   node web/tools/e2e-fund.mjs
//
// Uses .keys/deployer.key (throwaway testnet wallet). Nothing here runs on mainnet: it checks
// the chain id first and refuses anywhere else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  keccak256,
  toHex,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RPC = "https://rpc-test.qday.info";
const CHAIN_ID = 44005;
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const ESCROW = process.env.NEXT_PUBLIC_ESCROW_AEVUM ?? "0x0b9165e8665e76485ac8cf48c69e09352a7ae1aa";
const API = process.env.API_BASE ?? "http://localhost:3000";

const escrowAbi = [
  {
    type: "function", name: "create", stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "milestones", type: "tuple[]", components: [
        { name: "amount", type: "uint96" }, { name: "deadline", type: "uint64" },
      ] },
    ], outputs: [],
  },
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "authorizationNonce", stateMutability: "view", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "dealOf", stateMutability: "view", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [
    { type: "tuple", components: [
      { name: "buyer", type: "address" }, { name: "state", type: "uint8" }, { name: "createdAt", type: "uint64" },
      { name: "seller", type: "address" }, { name: "totalReleased", type: "uint96" }, { name: "arbiter", type: "address" },
      { name: "total", type: "uint96" },
      { name: "milestones", type: "tuple[]", components: [
        { name: "amount", type: "uint96" }, { name: "deadline", type: "uint64" }, { name: "evidenceAt", type: "uint64" },
        { name: "approved", type: "bool" }, { name: "released", type: "bool" }, { name: "evidence", type: "bytes32" },
      ] },
    ] },
  ] },
  { type: "function", name: "approveMilestone", stateMutability: "nonpayable", inputs: [{ name: "escrowId", type: "bytes32" }, { name: "index", type: "uint256" }], outputs: [] },
];
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const receiveTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

const key = readFileSync(join(ROOT, ".keys", "deployer.key"), "utf8").trim();
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const publicClient = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) die(`refusing to run on chain ${chainId} (this script is testnet-only)`);
  console.log(`buyer/relayer: ${account.address}`);

  const seller = "0x9be4343DdB51c0288A01f94be539893d1ECDde44";
  // Must differ from both buyer (msg.sender) and seller or create() reverts SameAddress().
  const arbiter = "0x000000000000000000000000000000000000dEaD";
  const escrowId = keccak256(toHex(`e2e-${Date.now()}`));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const milestones = [
    { amount: parseUnits("1.5", 6), deadline: now + 3600n },
    { amount: parseUnits("0.5", 6), deadline: now + 7200n },
  ];
  const total = milestones.reduce((s, m) => s + m.amount, 0n);

  // 1. create
  const createHash = await wallet.sendTransaction({
    account, to: ESCROW, chainId: CHAIN_ID, type: "legacy",
    data: encodeCreate(escrowId, seller, arbiter, milestones),
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });
  ok(`deal created  id=${escrowId.slice(0, 12)}…  tx=${createHash}`);

  // 2. sign the EIP-3009 authorization exactly like the browser does
  const nonce = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "authorizationNonce", args: [escrowId] });
  const validAfter = 0n;
  const validBefore = now + 600n;
  const signature = await account.signTypedData({
    domain: { name: "tUSD8", version: "2", chainId: CHAIN_ID, verifyingContract: TUSD8 },
    types: receiveTypes,
    primaryType: "ReceiveWithAuthorization",
    message: { from: account.address, to: ESCROW, value: total, validAfter, validBefore, nonce },
  });

  // 3. hand it to the relayer (the UI's own endpoint)
  const res = await fetch(`${API}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "fundEscrow", chainId: CHAIN_ID, escrowId, from: account.address,
      validAfter: validAfter.toString(), validBefore: validBefore.toString(), signature,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.hash) die(`relayer refused: ${data.error ?? res.status}`);
  await publicClient.waitForTransactionReceipt({ hash: data.hash });
  ok(`funded gaslessly via /api/relay (buyer paid 0 gas)  tx=${data.hash}`);

  const deal = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "dealOf", args: [escrowId] });
  if (deal.state !== 2n && Number(deal.state) !== 2) die(`expected Funded, got state=${deal.state}`);
  const escrowBalance = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [ESCROW] });
  if (escrowBalance < total) die(`escrow holds ${escrowBalance}, expected >= ${total}`);
  ok(`on chain: state=Funded, escrow balance=${escrowBalance / 10n ** 6n} tUSD8`);

  // 4. release milestone 1 to the seller
  const approveHash = await wallet.sendTransaction({
    account, to: ESCROW, chainId: CHAIN_ID, type: "legacy",
    data: approveMilestoneData(escrowId, 0n),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (receipt.status !== "success") die("approveMilestone reverted");
  const sellerBal = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [seller] });
  ok(`milestone 1 released → seller holds ${sellerBal / 10n ** 6n} tUSD8  tx=${approveHash}`);

  console.log(`\nE2E OK — explorer: https://explorer-test.qday.info/tx/${createHash}`);
}

// minimal wrappers around viem's ABI encoder
function encodeCreate(id, seller, arbiter, milestones) {
  return encodeFunctionData({ abi: escrowAbi, functionName: "create", args: [id, seller, arbiter, milestones] });
}
function approveMilestoneData(id, index) {
  return encodeFunctionData({ abi: escrowAbi, functionName: "approveMilestone", args: [id, index] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
