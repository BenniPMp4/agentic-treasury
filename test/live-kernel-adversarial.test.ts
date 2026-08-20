// Closes the gap PHASE3.md calls out explicitly: "SessionKeyVault.sol is
// a good harness but it is your own contract, and the security claim is
// currently unproven against production account abstraction." This test
// runs one adversarial case — spend to a disallowed counterparty — against
// a *real* ZeroDev Kernel smart account on Base Sepolia, via a real
// Pimlico bundler, so the rejection is a genuine ERC-4337 UserOperation
// failure, not anything this repo's own contract decided.
//
// Gated behind real (testnet) credentials this sandbox doesn't have — see
// secrets/.env.example. Skipped, not failed, when they're absent, so
// `npm test` stays green and deterministic without them.
//
// Honesty note for whoever adds credentials and runs this for real: the
// ZeroDev/permissionless APIs below are written against the current docs
// as of this session (docs.zerodev.app, docs.pimlico.io — see README.md's
// Phase 2 "Production path" section for what was checked), but this
// specific test has never actually executed against a live bundler —
// there was no way to verify it end-to-end without the credentials it's
// gated behind. Treat a first run's failures as real signal to debug
// against, the same way test/adversarial.test.ts's local-chain suite was
// built — not as evidence this file is wrong.
import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY;
const OWNER_PRIVATE_KEY = process.env.LIVE_TEST_OWNER_PRIVATE_KEY as Hex | undefined;
const DISALLOWED_TARGET = (process.env.LIVE_TEST_DISALLOWED_TARGET ??
  "0x000000000000000000000000000000000000dEaD") as Address;

const hasCredentials = Boolean(RPC_URL && PIMLICO_API_KEY && OWNER_PRIVATE_KEY);

describe.skipIf(!hasCredentials)("live: real ZeroDev Kernel account on Base Sepolia", () => {
  it(
    "rejects a session-key spend to a target outside its call policy — a real UserOperation failure, not our contract's opinion",
    async () => {
      const { signerToEcdsaValidator } = await import("@zerodev/ecdsa-validator");
      const { createKernelAccount, createKernelAccountClient } = await import("@zerodev/sdk");
      const { toPermissionValidator } = await import("@zerodev/permissions");
      const { toECDSASigner } = await import("@zerodev/permissions/signers");
      const { toCallPolicy, CallPolicyVersion } = await import("@zerodev/permissions/policies");
      const { createPimlicoClient } = await import("permissionless/clients/pimlico");

      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
      const entryPoint = { address: entryPoint07Address, version: "0.7" as const };
      const kernelVersion = "0.3.1" as const;

      const owner = privateKeyToAccount(OWNER_PRIVATE_KEY!);
      const ecdsaValidator = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion });

      // Allow-list exactly one address the account may pay — anything
      // else must be rejected at the ERC-4337 validation step.
      const allowedTarget = owner.address; // paying yourself back is always "allowed" for this smoke test
      const callPolicy = toCallPolicy({
        policyVersion: CallPolicyVersion.V0_0_4,
        permissions: [{ target: allowedTarget }],
      });

      const sessionKeyAccount = privateKeyToAccount(generatePrivateKey());
      const sessionSigner = await toECDSASigner({ signer: sessionKeyAccount });
      const permissionValidator = await toPermissionValidator(publicClient, {
        entryPoint,
        kernelVersion,
        signer: sessionSigner,
        policies: [callPolicy],
      });

      const kernelAccount = await createKernelAccount(publicClient, {
        entryPoint,
        kernelVersion,
        plugins: { sudo: ecdsaValidator, regular: permissionValidator },
      });

      const pimlicoUrl = `https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${PIMLICO_API_KEY}`;
      const pimlicoClient = createPimlicoClient({
        transport: http(pimlicoUrl),
        entryPoint,
      });

      const smartAccountClient = createKernelAccountClient({
        account: kernelAccount,
        chain: baseSepolia,
        bundlerTransport: http(pimlicoUrl),
        paymaster: pimlicoClient,
        userOperation: {
          estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
        },
      });

      // A zero-value call to the disallowed target — the call policy
      // should reject this at validation, before any real value moves.
      await expect(
        smartAccountClient.sendUserOperation({
          calls: [{ to: DISALLOWED_TARGET, value: 0n, data: "0x" }],
        })
      ).rejects.toThrow();
    },
    120_000
  );
});

if (!hasCredentials) {
  console.log(
    "[live-kernel-adversarial] skipped — set BASE_SEPOLIA_RPC_URL, PIMLICO_API_KEY and " +
      "LIVE_TEST_OWNER_PRIVATE_KEY (a funded testnet wallet) in secrets/.env to run this for real."
  );
}
