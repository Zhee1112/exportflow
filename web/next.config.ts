import type { NextConfig } from "next";

// ---- Security headers (OWASP A05: security misconfiguration) ----
// No nonces here, so scripts/styles keep 'unsafe-inline': React escapes every value we
// render and the app never injects raw HTML (no dangerouslySetInnerHTML/eval anywhere),
// so the policy is defence in depth rather than the only barrier.
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Images can't execute: allow remote wallet/RPC icons as well as our own assets.
  "img-src 'self' blob: data: https:",
  "font-src 'self'",
  // Wallets talk to arbitrary HTTPS RPCs (and, when configured, the WalletConnect relay
  // over wss). Plain http is only needed for the local fork/anvil node.
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  // WalletConnect / MetaMask SDK render their modals in sandboxed iframes.
  "frame-src 'self' https://*.walletconnect.com https://*.metamask.io",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const config: NextConfig = {
  // The shared config package ships TypeScript source.
  transpilePackages: ["@aevum-kit/aevum"],
  // Keep agent-facing dev/build commands working when a security advisory lands:
  // assess and stop before upgrading instead of hard-failing the command.
  experimental: {
    agentUpgrade: "security",
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default config;
