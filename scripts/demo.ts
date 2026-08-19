// Phase 2 demo (PHASE2.md "Definition of done"):
//   1. Provisions a smart account for a simulated agent
//   2. Issues an entitlement and its session key
//   3. Pays a mock x402 endpoint
//   4. Attempts an over-cap spend with the policy engine compromised,
//      and shows the on-chain revert  <- this print IS the demo
//   5. Prints the reconciliation report
//
// Everything here runs against the local chain (src/chain/localChain.ts)
// except step 3's actual payment, which needs a funded Base Sepolia
// wallet this sandbox doesn't have — see the step 3 section below for
// exactly what that step does with and without one.
import { InMemoryLedger } from "../src/ledger.js";
import { EntitlementStore } from "../src/entitlements.js";
import { startLocalChain } from "../src/chain/localChain.js";
import { AccountRegistry, provisionSmartAccountLocal } from "../src/chain/account.js";
import {
  SessionKeyRegistry,
  issueSessionKeyForEntitlement,
  attemptSpend,
} from "../src/chain/sessionKeys.js";
import { reconcile } from "../src/chain/reconcile.js";
import { parseUSDC, formatUSDC, usdcBalanceOf } from "../src/chain/usdc.js";
import { startSeller, DEFAULT_PORT } from "../mock/seller.js";
import { createPayingFetch, probePaymentRequirements } from "../src/adapters/x402.js";

function section(title: string): void {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

// The whole point of this suite (PHASE2.md): this engine approves
// everything, and it must not matter.
const compromisedPolicyEngine = {
  approve(_request: unknown): true {
    return true;
  },
};

async function main() {
  section("Phase 2 demo: on-chain entitlement enforcement");

  const chain = await startLocalChain();
  const chainDeps = { publicClient: chain.publicClient, vaultAbi: chain.artifacts.SessionKeyVault.abi };
  const ownerAccount = chain.accounts[0]!.account;
  const ownerWallet = chain.walletClientFor(ownerAccount);
  const relayerAccount = chain.accounts[1]!.account;
  const relayerWallet = chain.walletClientFor(relayerAccount);
  const counterparty = chain.accounts[9]!.account.address;

  const ledger = new InMemoryLedger();
  ledger.createPool("default", parseUSDC("10000"));
  const entitlements = new EntitlementStore(ledger);
  const accountRegistry = new AccountRegistry();
  const sessionRegistry = new SessionKeyRegistry();

  // --- Step 1: provision a smart account -----------------------------
  section("Step 1: provision a smart account for demo_agent");
  const agent = await provisionSmartAccountLocal({
    agentId: "demo_agent",
    chain,
    registry: accountRegistry,
    ownerAddress: ownerAccount.address,
    fundingAmount: parseUSDC("1000"),
  });
  console.log(`vault deployed at ${agent.vault}`);
  console.log(`vault USDC balance: ${formatUSDC(await usdcBalanceOf(chain.publicClient, chain.usdcAddress, agent.vault))}`);

  // --- Step 2: issue an entitlement and its session key ---------------
  section("Step 2: issue an entitlement and its session key");
  const entitlement = entitlements.request({
    agent_id: "demo_agent",
    amount: parseUSDC("20"),
    ttl_seconds: 3600,
  });
  console.log(`entitlement ${entitlement.id}: granted ${formatUSDC(entitlement.amount_granted)} USDC`);

  const sessionKey = await issueSessionKeyForEntitlement({
    entitlementId: entitlement.id,
    agentId: "demo_agent",
    vault: agent.vault,
    amountGranted: entitlement.amount_granted,
    expiresAtMs: entitlement.expires_at,
    counterpartyAllow: [],
    chain: chainDeps,
    registry: sessionRegistry,
    ownerWallet,
    ownerAccount,
  });
  console.log(`session key ${sessionKey.session_key} issued on vault ${sessionKey.vault} (tx ${sessionKey.tx_hash})`);

  // A legitimate spend, properly recorded in the ledger — this is what
  // step 5's reconciliation report should find *nothing* wrong with.
  const goodSpend = await attemptSpend({
    record: sessionKey,
    target: counterparty,
    amount: parseUSDC("5"),
    chain: chainDeps,
    relayerWallet,
    relayerAccount,
  });
  if (goodSpend.ok) {
    entitlements.recordSpend(entitlement.id, parseUSDC("5"));
    console.log(`spent 5.0 USDC to ${counterparty} (tx ${goodSpend.tx_hash}) — ledger and chain agree`);
  }

  // --- Step 3: pay the mock x402 endpoint ------------------------------
  section("Step 3: pay the mock x402 paid endpoint");
  const seller = await startSeller();
  const url = `http://localhost:${DEFAULT_PORT}/treasury-report`;
  const probe = await probePaymentRequirements(url);
  console.log(`GET ${url} (no payment) -> HTTP ${probe.status}`);
  console.log(`payment requirements: ${JSON.stringify(probe.paymentRequirements)}`);

  const payerKey = process.env.DEMO_X402_PRIVATE_KEY as `0x${string}` | undefined;
  if (payerKey) {
    try {
      const payingFetch = createPayingFetch(payerKey);
      const paid = await payingFetch(url);
      const body = await paid.json();
      console.log(`paid successfully -> HTTP ${paid.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      console.log(`payment attempt failed: ${(error as Error).message}`);
    }
  } else {
    console.log(
      "DEMO_X402_PRIVATE_KEY not set — skipping the actual payment. " +
        "The 402 response above is real and live (this sandbox has no funded " +
        "Base Sepolia wallet to complete the payment with; testnet USDC is free " +
        "from Circle's faucet — put a funded key in the gitignored secrets/.env " +
        "as DEMO_X402_PRIVATE_KEY to complete this step for real)."
    );
  }
  seller.close();

  // --- Step 4: compromised policy engine, over-cap spend --------------
  section("Step 4: compromised policy engine attempts an over-cap spend");
  console.log("policy engine consulted: approves unconditionally ->", compromisedPolicyEngine.approve({}));
  const overCap = await attemptSpend({
    record: sessionKey,
    target: counterparty,
    amount: parseUSDC("999"),
    chain: chainDeps,
    relayerWallet,
    relayerAccount,
  });
  if (overCap.ok) {
    console.log("!! UNEXPECTED: over-cap spend succeeded — this would be the finding of a real audit.");
  } else {
    console.log(`chain rejected it anyway: revert reason = ${overCap.revert_reason}`);
    console.log("(the backend's policy engine said yes; the chain said no — that's invariant 11.)");
  }

  // A second, unrecorded on-chain spend — simulates "the ledger write
  // failed" so step 5 has a genuine divergence to report on.
  const unrecorded = await attemptSpend({
    record: sessionKey,
    target: counterparty,
    amount: parseUSDC("3"),
    chain: chainDeps,
    relayerWallet,
    relayerAccount,
  });
  if (unrecorded.ok) {
    console.log(`(also spent 3.0 USDC on chain without telling the ledger, to give reconciliation something to find)`);
  }

  // --- Step 5: reconciliation report -----------------------------------
  section("Step 5: reconciliation report");
  const report = await reconcile({
    publicClient: chain.publicClient,
    vaultAbi: chain.artifacts.SessionKeyVault.abi,
    vaults: [agent.vault],
    registry: sessionRegistry,
    entitlements,
  });
  console.log(`divergences found: ${report.events.length}`);
  console.log(`  corrected (chain_ahead / ledger_ahead): ${report.corrected}`);
  console.log(`  unattributed: ${report.unattributed}`);
  for (const event of report.events) {
    console.log(
      `  - [${event.direction}] entitlement=${event.entitlement_id ?? "(none)"} ` +
        `session_key=${event.session_key} chain_spent=${formatUSDC(event.chain_spent)} ` +
        `ledger_spent=${event.ledger_spent === null ? "(none)" : formatUSDC(event.ledger_spent)}`
    );
  }
  console.log(
    `\nentitlement ${entitlement.id} after reconciliation: spent = ${formatUSDC(
      entitlements.checkBalance(entitlement.id).spent
    )} USDC (ledger now matches the chain)`
  );

  section("Done");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
