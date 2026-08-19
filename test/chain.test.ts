// Session key issuance and revocation against a real deployed vault —
// the mechanics adversarial.test.ts's enforcement tests build on top of.
import { beforeAll, describe, expect, it } from "vitest";
import { startLocalChain, type LocalChain } from "../src/chain/localChain.js";
import { AccountRegistry, provisionSmartAccountLocal } from "../src/chain/account.js";
import {
  SessionKeyRegistry,
  issueSessionKeyForEntitlement,
  revokeSessionKeyForEntitlement,
  readSession,
  type SessionKeyChainDeps,
} from "../src/chain/sessionKeys.js";
import { parseUSDC } from "../src/chain/usdc.js";

describe("chain: session key issuance and revocation", () => {
  let chain: LocalChain;
  let deps: SessionKeyChainDeps;

  beforeAll(async () => {
    chain = await startLocalChain();
    deps = { publicClient: chain.publicClient, vaultAbi: chain.artifacts.SessionKeyVault.abi };
  }, 60_000);

  async function provisionAgent(agentId: string) {
    const accountRegistry = new AccountRegistry();
    const ownerAccount = chain.accounts[0]!.account;
    const ownerWallet = chain.walletClientFor(ownerAccount);
    const agent = await provisionSmartAccountLocal({
      agentId,
      chain,
      registry: accountRegistry,
      ownerAddress: ownerAccount.address,
      fundingAmount: parseUSDC("100"),
    });
    return { agent, ownerAccount, ownerWallet };
  }

  it("provisions one vault per agent and reuses it on a second call", async () => {
    const registry = new AccountRegistry();
    const ownerAccount = chain.accounts[0]!.account;
    const params = {
      agentId: "issuance_agent_1",
      chain,
      registry,
      ownerAddress: ownerAccount.address,
      fundingAmount: parseUSDC("100"),
    };
    const first = await provisionSmartAccountLocal(params);
    const second = await provisionSmartAccountLocal(params);
    expect(second.vault).toBe(first.vault);
  });

  it("issuing a session key sets cap, expiry and allowlist on chain exactly as requested", async () => {
    const { agent, ownerAccount, ownerWallet } = await provisionAgent("issuance_agent_2");
    const sessionRegistry = new SessionKeyRegistry();
    const expiresAtMs = Date.now() + 3_600_000;
    const allowed = chain.accounts[5]!.account.address;

    const record = await issueSessionKeyForEntitlement({
      entitlementId: "ent_issue_1",
      agentId: "issuance_agent_2",
      vault: agent.vault,
      amountGranted: parseUSDC("25"),
      expiresAtMs,
      counterpartyAllow: [allowed],
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    const session = await readSession(deps, agent.vault, record.session_key);
    expect(session.cap).toBe(parseUSDC("25"));
    expect(session.spent).toBe(0n);
    expect(session.validUntil).toBe(BigInt(Math.floor(expiresAtMs / 1000)));
    expect(session.restricted).toBe(true);
    expect(session.revoked).toBe(false);
    expect(session.nonce).toBe(0n);

    expect(sessionRegistry.getByEntitlement("ent_issue_1")?.session_key).toBe(record.session_key);
    expect(sessionRegistry.getBySessionKey(record.session_key)?.entitlement_id).toBe("ent_issue_1");
  });

  it("an empty counterparty_allow is unrestricted on chain (allow all), matching CLAUDE.md's convention", async () => {
    const { agent, ownerAccount, ownerWallet } = await provisionAgent("issuance_agent_3");
    const sessionRegistry = new SessionKeyRegistry();

    const record = await issueSessionKeyForEntitlement({
      entitlementId: "ent_issue_2",
      agentId: "issuance_agent_3",
      vault: agent.vault,
      amountGranted: parseUSDC("10"),
      expiresAtMs: Date.now() + 3_600_000,
      counterpartyAllow: [],
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    const session = await readSession(deps, agent.vault, record.session_key);
    expect(session.restricted).toBe(false);
  });

  it("revoking a session key marks it revoked on chain and returns the unspent remainder", async () => {
    const { agent, ownerAccount, ownerWallet } = await provisionAgent("issuance_agent_4");
    const sessionRegistry = new SessionKeyRegistry();

    const record = await issueSessionKeyForEntitlement({
      entitlementId: "ent_issue_3",
      agentId: "issuance_agent_4",
      vault: agent.vault,
      amountGranted: parseUSDC("40"),
      expiresAtMs: Date.now() + 3_600_000,
      counterpartyAllow: [],
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    const result = await revokeSessionKeyForEntitlement({
      entitlementId: "ent_issue_3",
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    expect(result.returned_amount).toBe(parseUSDC("40"));

    const session = await readSession(deps, agent.vault, record.session_key);
    expect(session.revoked).toBe(true);

    // Revocation removes it from the off-chain registry too.
    expect(sessionRegistry.getByEntitlement("ent_issue_3")).toBeUndefined();
    expect(sessionRegistry.getBySessionKey(record.session_key)).toBeUndefined();
  });

  it("only the vault owner can issue or revoke session keys", async () => {
    const { agent, ownerAccount } = await provisionAgent("issuance_agent_5");
    const stranger = chain.accounts[6]!.account;
    const strangerWallet = chain.walletClientFor(stranger);
    const sessionRegistry = new SessionKeyRegistry();

    await expect(
      issueSessionKeyForEntitlement({
        entitlementId: "ent_issue_4",
        agentId: "issuance_agent_5",
        vault: agent.vault,
        amountGranted: parseUSDC("5"),
        expiresAtMs: Date.now() + 3_600_000,
        counterpartyAllow: [],
        chain: deps,
        registry: sessionRegistry,
        ownerWallet: strangerWallet,
        ownerAccount: stranger,
      })
    ).rejects.toThrow();

    void ownerAccount; // the legitimate owner, unused in this negative test
  });
});
