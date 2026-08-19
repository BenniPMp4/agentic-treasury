// Token helpers. USDC uses 6 decimals on every chain it's deployed to
// (Base Sepolia testnet USDC included) — this module doesn't care whether
// the address behind it is Circle's real testnet USDC or our local
// MockUSDC; both speak the same minimal ERC20 surface.
import type { Address, PublicClient } from "viem";
import { formatUnits, parseUnits } from "viem";

export const USDC_DECIMALS = 6;

const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** "12.50" -> 12_500_000n */
export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/** 12_500_000n -> "12.5" */
export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

export async function usdcBalanceOf(
  publicClient: PublicClient,
  usdcAddress: Address,
  account: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_READ_ABI,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}
