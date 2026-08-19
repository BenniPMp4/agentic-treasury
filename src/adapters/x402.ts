// x402 client — pay-on-402 flow (PHASE2.md). Wraps `fetch` so a 402
// Payment Required response is paid automatically, using @x402/fetch
// against Base Sepolia testnet USDC (network id eip155:84532).
//
// Paying for real requires a funded Base Sepolia wallet — real testnet
// USDC from Circle's faucet, no mainnet funds involved either way, but a
// credential this sandbox doesn't have. scripts/demo.ts calls
// `probePaymentRequirements` unconditionally (works with zero credentials
// — a 402 response is public information) and only calls
// `createPayingFetch` when a private key is actually configured.
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const BASE_SEPOLIA_NETWORK = "eip155:84532";

/** A fetch that pays automatically on 402, signing with `privateKey`. */
export function createPayingFetch(privateKey: Hex): typeof fetch {
  const account = privateKeyToAccount(privateKey);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE_SEPOLIA_NETWORK, client: new ExactEvmScheme(account) }],
  });
}

export interface PaymentRequirementsProbe {
  status: number;
  paymentRequirements: unknown;
}

/** Makes the unauthenticated request and returns the 402's payment
 * requirements — no wallet needed. This is what proves the paywall is
 * real and wired correctly (real Base Sepolia USDC contract address,
 * real price) even when nothing in this process can afford to pay it.
 * x402 v2 puts requirements in the `PAYMENT-REQUIRED` response header —
 * a base64url JSON payload — leaving the JSON body empty. */
export async function probePaymentRequirements(url: string): Promise<PaymentRequirementsProbe> {
  const response = await fetch(url);
  const header = response.headers.get("PAYMENT-REQUIRED");
  const paymentRequirements = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : undefined;
  return { status: response.status, paymentRequirements };
}
