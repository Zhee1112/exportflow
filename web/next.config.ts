import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared config package ships TypeScript source.
  transpilePackages: ["@aevum-kit/aevum"],
  // Keep agent-facing dev/build commands working when a security advisory lands:
  // assess and stop before upgrading instead of hard-failing the command.
  experimental: {
    agentUpgrade: "security",
  },
};

export default config;
