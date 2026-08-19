// Smart account provisioning per agent.
//
// Two paths:
//
// - `provisionSmartAccountLocal` deploys one SessionKeyVault (see
//   contracts/SessionKeyVault.sol) per agent on the local dev chain, funded
//   with test USDC. This is what the test suite and `npm run demo` use —
//   deterministic, offline, no credentials.
//
// - `provisionSmartAccountLive` provisions a real ZeroDev Kernel smart
//   account per agent on Base Sepolia, via permissionless.js + a Pimlico
//   bundler/paymaster. This is the production path the PHASE2.md stack
//   describes. It requires real (testnet) credentials that don't exist in
//   this sandbox, so it's written against the current SDKs but is not
//   exercised by `npm test` — see README.md "Why ZeroDev Kernel" for why
//   session-key policy composition needs @zerodev/permissions rather than
//   base permissionless.js's plain `toKernelSmartAccount`.
//
// One agent = one smart account either way. Delegation (parent_id) stays
// off-chain per PHASE2.md — only entitlements that actually spend get a
// session key on their agent's account (see sessionKeys.ts).
import type { Address, Hex } from "viem";
import type { LocalChain } from "./localChain.js";

export interface AgentAccount {
  agent_id: string;
  vault: Address;
}

/** Per-process registry of agent -> smart account. One instance per
 * treasury backend deployment; tests construct their own so runs don't
 * leak state into each other. */
export class AccountRegistry {
  private byAgent = new Map<string, AgentAccount>();

  get(agentId: string): AgentAccount | undefined {
    return this.byAgent.get(agentId);
  }

  set(account: AgentAccount): void {
    this.byAgent.set(account.agent_id, account);
  }
}

export interface ProvisionLocalParams {
  agentId: string;
  chain: LocalChain;
  registry: AccountRegistry;
  /** the treasury backend's own signer — becomes the vault's `owner`,
   * i.e. the only address that can issue/revoke session keys on it. */
  ownerAddress: Address;
  /** USDC minted into the vault at provisioning, representing pool
   * capital backing this agent. Session-key caps (from entitlements) are
   * the real spend boundary; this just needs to cover the largest cap
   * any session key on this vault will be issued. */
  fundingAmount: bigint;
}

export async function provisionSmartAccountLocal(params: ProvisionLocalParams): Promise<AgentAccount> {
  const existing = params.registry.get(params.agentId);
  if (existing) return existing;

  const vault = await params.chain.deployVault(params.ownerAddress);
  await params.chain.mintUSDC(vault, params.fundingAmount);

  const account: AgentAccount = { agent_id: params.agentId, vault };
  params.registry.set(account);
  return account;
}

export interface ProvisionLiveParams {
  agentId: string;
  /** the treasury backend's ECDSA signer — becomes the Kernel account's
   * sudo validator owner. */
  ownerPrivateKey: Hex;
}

export interface LiveAgentAccount extends AgentAccount {
  chainId: number;
}

/**
 * Provisions a real Kernel smart account on Base Sepolia via ZeroDev +
 * permissionless.js's Pimlico bundler client. Requires:
 *   BASE_SEPOLIA_RPC_URL
 *   PIMLICO_API_KEY
 * in the environment (put them in the gitignored secrets/.env, never in
 * source — see secrets/README.md). Session-key policies (cap, expiry,
 * target allowlist) are attached separately by sessionKeys.ts's live
 * counterpart, mirroring the same PHASE2.md mapping table this file's
 * local path encodes directly in SessionKeyVault.sol.
 */
export async function provisionSmartAccountLive(params: ProvisionLiveParams): Promise<LiveAgentAccount> {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  const pimlicoApiKey = process.env.PIMLICO_API_KEY;
  if (!rpcUrl || !pimlicoApiKey) {
    throw new Error(
      "provisionSmartAccountLive requires BASE_SEPOLIA_RPC_URL and PIMLICO_API_KEY. " +
        "These are real testnet credentials this sandbox doesn't have — put them in the " +
        "gitignored secrets/.env for a real deployment. Use provisionSmartAccountLocal for tests/demo."
    );
  }

  const [{ createPublicClient, http }, { baseSepolia }, { privateKeyToAccount }, { entryPoint07Address }] =
    await Promise.all([import("viem"), import("viem/chains"), import("viem/accounts"), import("viem/account-abstraction")]);
  const { createKernelAccount } = await import("@zerodev/sdk");
  const { signerToEcdsaValidator } = await import("@zerodev/ecdsa-validator");

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const owner = privateKeyToAccount(params.ownerPrivateKey);
  const entryPoint = { address: entryPoint07Address, version: "0.7" as const };

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: owner,
    entryPoint,
    kernelVersion: "0.3.1",
  });

  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion: "0.3.1",
  });

  // Pimlico bundler/paymaster wiring (used when actually sending
  // UserOperations — see sessionKeys.ts's live spend path) references
  // this same apiKey/entryPoint pair; not needed just to derive the
  // account's counterfactual address, which is deterministic from the
  // owner key and doesn't require a bundler call.
  void pimlicoApiKey;

  return { agent_id: params.agentId, vault: kernelAccount.address, chainId: baseSepolia.id };
}
