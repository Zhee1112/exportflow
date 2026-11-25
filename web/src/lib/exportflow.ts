import { keccak256, toHex, type Address, type Hex } from "viem";

/** The three ExportFlow contracts. Addresses come from NEXT_PUBLIC_* (see lib/env.ts). */
export const ESCROW_STATE = ["None", "Created", "Funded", "Disputed", "Completed", "Refunded", "Cancelled"] as const;
export type EscrowState = (typeof ESCROW_STATE)[number];

export const STATE_LABEL: Record<EscrowState, string> = {
  None: "Not created",
  Created: "Waiting for funding",
  Funded: "In progress",
  Disputed: "Disputed",
  Completed: "Completed",
  Refunded: "Refunded",
  Cancelled: "Cancelled",
};

export const STATE_TONE: Record<EscrowState, "good" | "warn" | "bad" | "idle"> = {
  None: "idle",
  Created: "warn",
  Funded: "good",
  Disputed: "bad",
  Completed: "good",
  Refunded: "warn",
  Cancelled: "idle",
};

export const escrowAbi = [
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "arbiter", type: "address" },
      {
        name: "milestones",
        type: "tuple[]",
        components: [
          { name: "amount", type: "uint96" },
          { name: "deadline", type: "uint64" },
        ],
      },
    ],
    outputs: [],
  },
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "fundWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationNonce",
    stateMutability: "view",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "submitEvidence",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "index", type: "uint256" },
      { name: "evidence", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approveMilestone",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimAfterDeadline",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "raiseDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "toSeller", type: "uint96" },
    ],
    outputs: [],
  },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "dealOf",
    stateMutability: "view",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "buyer", type: "address" },
          { name: "state", type: "uint8" },
          { name: "createdAt", type: "uint64" },
          { name: "seller", type: "address" },
          { name: "totalReleased", type: "uint96" },
          { name: "arbiter", type: "address" },
          { name: "total", type: "uint96" },
          {
            name: "milestones",
            type: "tuple[]",
            components: [
              { name: "amount", type: "uint96" },
              { name: "deadline", type: "uint64" },
              { name: "evidenceAt", type: "uint64" },
              { name: "approved", type: "bool" },
              { name: "released", type: "bool" },
              { name: "evidence", type: "bytes32" },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "responseWindow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "Created",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "arbiter", type: "address", indexed: false },
      { name: "total", type: "uint96", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MilestoneReleased",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "amount", type: "uint96", indexed: false },
      { name: "byBuyer", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DisputeRaised",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

export const sessionPolicyAbi = [
  {
    type: "function",
    name: "createSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "targets", type: "address[]" },
      { name: "selectors", type: "bytes4[]" },
      { name: "maxCalls", type: "uint32" },
      { name: "validAfter", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "spendToken", type: "address" },
      { name: "spendCap", type: "uint96" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    type: "function",
    name: "spend",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint96" },
    ],
    outputs: [],
  },
  { type: "function", name: "revokeSession", stateMutability: "nonpayable", inputs: [{ name: "sessionId", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "sessionOf",
    stateMutability: "view",
    inputs: [{ name: "sessionId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "delegate", type: "address" },
          { name: "validAfter", type: "uint64" },
          { name: "active", type: "bool" },
          { name: "validUntil", type: "uint64" },
          { name: "maxCalls", type: "uint32" },
          { name: "callsUsed", type: "uint32" },
          { name: "spendCap", type: "uint96" },
          { name: "spent", type: "uint96" },
          { name: "spendToken", type: "address" },
        ],
      },
      { type: "address" },
    ],
  },
  {
    type: "function",
    name: "isAllowed",
    stateMutability: "view",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "SessionCreated",
    inputs: [
      { name: "sessionId", type: "bytes32", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "maxCalls", type: "uint32", indexed: false },
      { name: "validUntil", type: "uint64", indexed: false },
      { name: "spendCap", type: "uint96", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Spent",
    inputs: [
      { name: "sessionId", type: "bytes32", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint96", indexed: false },
      { name: "spentTotal", type: "uint96", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SessionRevoked",
    inputs: [
      { name: "sessionId", type: "bytes32", indexed: true },
      { name: "by", type: "address", indexed: true },
    ],
  },
] as const;

export const docRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "docHash", type: "bytes32" },
      { name: "declaredOwner", type: "address" },
    ],
    outputs: [],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "docHash", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [{ name: "docHash", type: "bytes32" }],
    outputs: [
      { type: "bool" },
      { type: "address" },
      { type: "uint64" },
      { type: "bool" },
    ],
  },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "docHash", type: "bytes32" }], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "DocRegistered",
    inputs: [
      { name: "docHash", type: "bytes32", indexed: true },
      { name: "registeredBy", type: "address", indexed: true },
      { name: "declaredOwner", type: "address", indexed: true },
    ],
  },
] as const;

/** A fresh bytes32 id for a deal, the same way Checkout makes order ids. */
export function newDealId(): Hex {
  return keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
}

/** Short, human-friendly label for a bytes32 id. */
export function dealLabel(id: Hex): string {
  return `#${id.slice(2, 6).toUpperCase()}-${id.slice(-4).toUpperCase()}`;
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export const MILESTONE_DEMO = [
  { label: "DP 30% · production start", days: 2, amount: "600.00" },
  { label: "Shipment · BL uploaded", days: 5, amount: "800.00" },
  { label: "Delivery · COO confirmed", days: 8, amount: "600.00" },
] as const;

/** Demo counterparties: Rina (seller) and the arbiter. Both are testnet-only wallets. */
export const DEMO_SELLER: Address = "0x9be4343DdB51c0288A01f94be539893d1ECDde44";
export const DEMO_ARBITER: Address = "0x679b7D6381b6b7539adA98e7E4fed7ec63B90Fe1";
