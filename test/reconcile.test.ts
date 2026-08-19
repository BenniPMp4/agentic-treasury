// Divergence handling (invariant 11, PHASE2.md "Reconciliation"). Each of
// the three cases PHASE2.md calls out gets its own test:
//   1. chain ahead of ledger
//   2. ledger ahead of chain
//   3. chain spend with no ledger record at all (unattributed)
import { beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { InMemoryLedger } from "../src/ledger.js";
import { EntitlementStore } from "../src/entitlements.js";
import { startLocalChain, type LocalChain } from "../src/chain/localChain.js";
import { AccountRegistry, provisionSmartAccountLocal } from "../src/chain/account.js";
import {
  SessionKeyRegistry,
  issueSessionKeyForEntitlement,
  spendViaSessionKey,
  signSpend,
  relaySignedSpend,
  type SessionKeyChainDeps,
  type SessionKeyRecord,
} from "../src/chain/sessionKeys.js";
import { reconcile } from "../src/chain/reconcile.js";
import { parseUSDC } from "../src/chain/usdc.js";

describe("reconciliation: divergence handling", () => {
  let chain: LocalChain;
  let deps: SessionKeyChainDeps;
  let target: Address;
  let counter = 0;

  beforeAll(async () => {
    chain = await startLocalChain();
    deps = { publicClient: chain.publicClient, vaultAbi: chain.artifacts.SessionKeyVault.abi };
    target = chain.accounts[8]!.account.address;
  }, 60_000);

  /** A funded entitlement, backed by a real vault + session key, ready to
   * spend against. Returns everything a test needs to drive one of the
   * three divergence scenarios independently of the others. */
  async function setup() {
    counter += 1;
    const agentId = `recon_${counter}`;

    const ledger = new InMemoryLedger();
    ledger.createPool("default", parseUSDC("1000"));
    const entitlements = new EntitlementStore(ledger);
    const entitlement = entitlements.request({
      agent_id: agentId,
      amount: parseUSDC("50"),
      ttl_seconds: 3600,
    });

    const accountRegistry = new AccountRegistry();
    const ownerAccount = chain.accounts[0]!.account;
    const ownerWallet = chain.walletClientFor(ownerAccount);
    const relayerAccount = chain.accounts[1]!.account;
    const relayerWallet = chain.walletClientFor(relayerAccount);

    const agent = await provisionSmartAccountLocal({
      agentId,
      chain,
      registry: accountRegistry,
      ownerAddress: ownerAccount.address,
      fundingAmount: parseUSDC("50"),
    });

    const sessionRegistry = new SessionKeyRegistry();
    const record = await issueSessionKeyForEntitlement({
      entitlementId: entitlement.id,
      agentId,
      vault: agent.vault,
      amountGranted: entitlement.amount_granted,
      expiresAtMs: entitlement.expires_at,
      counterpartyAllow: [],
      chain: deps,
      registry: sessionRegistry,
      ownerWallet,
      ownerAccount,
    });

    return { entitlements, entitlement, agent, sessionRegistry, record, relayerWallet, relayerAccount };
  }

  it("case 1: chain ahead of ledger — settlement landed but the ledger write never happened", async () => {
    const { entitlements, entitlement, agent, sessionRegistry, record, relayerWallet, relayerAccount } =
      await setup();

    // A real on-chain spend, with no corresponding entitlements.recordSpend
    // call — exactly what "the ledger write failed" looks like.
    await spendViaSessionKey({
      record,
      target,
      amount: parseUSDC("20"),
      chain: deps,
      relayerWallet,
      relayerAccount,
    });
    expect(entitlements.checkBalance(entitlement.id).spent).toBe(0n);

    const report = await reconcile({
      publicClient: chain.publicClient,
      vaultAbi: chain.artifacts.SessionKeyVault.abi,
      vaults: [agent.vault],
      registry: sessionRegistry,
      entitlements,
    });

    expect(report.corrected).toBe(1);
    expect(report.unattributed).toBe(0);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]).toMatchObject({
      direction: "chain_ahead",
      entitlement_id: entitlement.id,
      chain_spent: parseUSDC("20"),
      ledger_spent: 0n,
    });
    // The ledger is corrected up to match the chain.
    expect(entitlements.checkBalance(entitlement.id).spent).toBe(parseUSDC("20"));
  });

  it("case 2: ledger ahead of chain — recorded in the ledger, but the transaction never landed", async () => {
    const { entitlements, entitlement, agent, sessionRegistry } = await setup();

    // Ledger-only spend: no transaction was ever sent for it.
    entitlements.recordSpend(entitlement.id, parseUSDC("15"));
    expect(entitlements.checkBalance(entitlement.id).spent).toBe(parseUSDC("15"));

    const report = await reconcile({
      publicClient: chain.publicClient,
      vaultAbi: chain.artifacts.SessionKeyVault.abi,
      vaults: [agent.vault],
      registry: sessionRegistry,
      entitlements,
    });

    expect(report.corrected).toBe(1);
    expect(report.unattributed).toBe(0);
    expect(report.events[0]).toMatchObject({
      direction: "ledger_ahead",
      entitlement_id: entitlement.id,
      chain_spent: 0n,
      ledger_spent: parseUSDC("15"),
    });
    // Released back down to what the chain actually shows: nothing spent.
    expect(entitlements.checkBalance(entitlement.id).spent).toBe(0n);
  });

  it("case 3: chain spend with no ledger record — a settlement that bypassed the MCP server", async () => {
    // Deploys a second vault plus a raw session key on top of the usual
    // setup() chain work — comfortably under 30s but over vitest's 5s default.
    const { entitlements, agent, sessionRegistry } = await setup();

    // A session key issued and spent through *directly on the vault*,
    // never going through issueSessionKeyForEntitlement — so it never
    // enters any SessionKeyRegistry. This is what "bypassed the MCP
    // server" means concretely: chain state exists that the backend's
    // own bookkeeping has no way to know about.
    const ownerAccount = chain.accounts[0]!.account;
    const ownerWallet = chain.walletClientFor(ownerAccount);
    const relayerAccount = chain.accounts[2]!.account;
    const relayerWallet = chain.walletClientFor(relayerAccount);

    const rogueVault = await chain.deployVault(ownerAccount.address);
    await chain.mintUSDC(rogueVault, parseUSDC("50"));

    const rogueSessionKeyPrivateKey = generatePrivateKey();
    const rogueSessionKeyAccount = privateKeyToAccount(rogueSessionKeyPrivateKey);
    const issueHash = await ownerWallet.writeContract({
      address: rogueVault,
      abi: chain.artifacts.SessionKeyVault.abi,
      functionName: "issueSessionKey",
      args: [rogueSessionKeyAccount.address, parseUSDC("50"), BigInt(Math.floor(Date.now() / 1000) + 3600), []],
      account: ownerAccount,
      chain: ownerWallet.chain,
    });
    await chain.publicClient.waitForTransactionReceipt({ hash: issueHash });

    // A perfectly valid session key and a perfectly valid signed spend —
    // it just never went through issueSessionKeyForEntitlement, so it
    // never entered any SessionKeyRegistry. That's the whole scenario.
    const rogueRecord: SessionKeyRecord = {
      entitlement_id: "not_registered",
      agent_id: "rogue",
      vault: rogueVault,
      session_key: rogueSessionKeyAccount.address,
      session_key_private_key: rogueSessionKeyPrivateKey,
    };
    const nonce = 0n;
    const amount = parseUSDC("9");
    const signature = await signSpend(deps, rogueRecord, target, amount, nonce);
    const attempt = await relaySignedSpend({
      record: rogueRecord,
      target,
      amount,
      nonce,
      signature,
      chain: deps,
      relayerWallet,
      relayerAccount,
    });
    expect(attempt.ok).toBe(true);

    const report = await reconcile({
      publicClient: chain.publicClient,
      vaultAbi: chain.artifacts.SessionKeyVault.abi,
      vaults: [agent.vault, rogueVault],
      registry: sessionRegistry, // does NOT know about rogueSessionKey
      entitlements,
    });

    expect(report.corrected).toBe(0);
    expect(report.unattributed).toBe(1);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]).toMatchObject({
      direction: "unattributed",
      entitlement_id: null,
      session_key: rogueSessionKeyAccount.address,
      vault: rogueVault,
      chain_spent: amount,
      ledger_spent: null,
    });
  }, 30_000);
});
