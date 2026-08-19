// The compromised-backend suite (PHASE2.md's "deliverable that matters").
//
// Premise: `compromisedPolicyEngine` below approves every request,
// unconditionally. Every test still asserts the chain rejects the spend —
// on the decoded on-chain revert reason, never on anything this file's
// backend-side code says. A test here that passed because a backend check
// said no would prove nothing about the security property and would be a
// failed test per PHASE2.md.
import { beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { startLocalChain, type LocalChain } from "../src/chain/localChain.js";
import { AccountRegistry, provisionSmartAccountLocal } from "../src/chain/account.js";
import {
  SessionKeyRegistry,
  issueSessionKeyForEntitlement,
  attemptSpend,
  relaySignedSpend,
  signSpend,
  type SessionKeyChainDeps,
} from "../src/chain/sessionKeys.js";
import { parseUSDC } from "../src/chain/usdc.js";

/** Approves literally everything. The point of this suite is that it
 * doesn't matter — see the module comment above. */
const compromisedPolicyEngine = {
  approve(_request: { entitlementId: string; amount: bigint; target: Address }): true {
    return true;
  },
};

describe("adversarial: compromised policy engine, chain must still enforce", () => {
  let chain: LocalChain;
  let deps: SessionKeyChainDeps;
  let allowedTarget: Address;
  let disallowedTarget: Address;
  let testCounter = 0;

  beforeAll(async () => {
    chain = await startLocalChain();
    deps = { publicClient: chain.publicClient, vaultAbi: chain.artifacts.SessionKeyVault.abi };
    allowedTarget = chain.accounts[8]!.account.address;
    disallowedTarget = chain.accounts[9]!.account.address;
  }, 60_000);

  /** Fresh agent, vault and session key per test so tests can't interfere
   * with each other's cap/nonce/expiry state. */
  async function setup(overrides: {
    cap: bigint;
    expiresAtMs: number;
    counterpartyAllow: Address[];
  }) {
    testCounter += 1;
    const agentId = `adversary_${testCounter}`;
    const registry = new AccountRegistry();
    const ownerAccount = chain.accounts[0]!.account;
    const ownerWallet = chain.walletClientFor(ownerAccount);
    const relayerAccount = chain.accounts[1]!.account;
    const relayerWallet = chain.walletClientFor(relayerAccount);

    const agent = await provisionSmartAccountLocal({
      agentId,
      chain,
      registry,
      ownerAddress: ownerAccount.address,
      fundingAmount: parseUSDC("1000"),
    });

    const sessionRegistry = new SessionKeyRegistry();
    const record = await issueSessionKeyForEntitlement({
      entitlementId: `ent_${agentId}`,
      agentId,
      vault: agent.vault,
      amountGranted: overrides.cap,
      expiresAtMs: overrides.expiresAtMs,
      counterpartyAllow: overrides.counterpartyAllow,
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    // The compromised policy engine, consulted and ignored — see module
    // comment. Every test below still asserts on the chain's own revert.
    compromisedPolicyEngine.approve({ entitlementId: record.entitlement_id, amount: 0n, target: allowedTarget });

    return { record, ownerWallet, ownerAccount, relayerWallet, relayerAccount, sessionRegistry };
  }

  it("1. rejects a spend exceeding amount_granted", async () => {
    const { record, relayerWallet, relayerAccount } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() + 60_000,
      counterpartyAllow: [],
    });

    const result = await attemptSpend({
      record,
      target: allowedTarget,
      amount: parseUSDC("15"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.revert_reason).toBe("CapExceeded");
  });

  it("2. rejects a spend after expires_at", async () => {
    const { record, relayerWallet, relayerAccount } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() - 60_000, // already expired
      counterpartyAllow: [],
    });

    const result = await attemptSpend({
      record,
      target: allowedTarget,
      amount: parseUSDC("1"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.revert_reason).toBe("SessionExpired");
  });

  it("3. rejects a spend to an address outside counterparty_allow", async () => {
    const { record, relayerWallet, relayerAccount } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() + 60_000,
      counterpartyAllow: [allowedTarget],
    });

    const result = await attemptSpend({
      record,
      target: disallowedTarget,
      amount: parseUSDC("1"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.revert_reason).toBe("TargetNotAllowed");
  });

  it("4. rejects a spend on a revoked entitlement", async () => {
    const { record, ownerWallet, ownerAccount, relayerWallet, relayerAccount, sessionRegistry } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() + 60_000,
      counterpartyAllow: [],
    });

    const { revokeSessionKeyForEntitlement } = await import("../src/chain/sessionKeys.js");
    const revoked = await revokeSessionKeyForEntitlement({
      entitlementId: record.entitlement_id,
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });
    expect(revoked.returned_amount).toBe(parseUSDC("10"));

    const result = await attemptSpend({
      record,
      target: allowedTarget,
      amount: parseUSDC("1"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.revert_reason).toBe("SessionRevokedErr");
  });

  it("5. rejects cumulative spend across multiple transactions exceeding the cap", async () => {
    const { record, relayerWallet, relayerAccount } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() + 60_000,
      counterpartyAllow: [],
    });

    const first = await attemptSpend({
      record,
      target: allowedTarget,
      amount: parseUSDC("6"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });
    expect(first.ok).toBe(true);

    // 6 + 6 = 12 > cap of 10, even though each individual call is well
    // within it.
    const second = await attemptSpend({
      record,
      target: allowedTarget,
      amount: parseUSDC("6"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.revert_reason).toBe("CapExceeded");
  });

  it("6. rejects replay of a previously valid signed operation", async () => {
    const { record, relayerWallet, relayerAccount } = await setup({
      cap: parseUSDC("10"),
      expiresAtMs: Date.now() + 60_000,
      counterpartyAllow: [],
    });

    const nonce = 0n;
    const amount = parseUSDC("3");
    const signature = await signSpend(deps, record, allowedTarget, amount, nonce);

    const first = await relaySignedSpend({
      record,
      target: allowedTarget,
      amount,
      nonce,
      signature,
      chain: deps,
      relayerWallet,
      relayerAccount,
    });
    expect(first.ok).toBe(true);

    // Exact same signed bytes, relayed again.
    const replay = await relaySignedSpend({
      record,
      target: allowedTarget,
      amount,
      nonce,
      signature,
      chain: deps,
      relayerWallet,
      relayerAccount,
    });

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.revert_reason).toBe("BadNonce");
  });
});
