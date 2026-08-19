// Local, in-process EVM used by the test suite and the demo script.
//
// Why: the adversarial suite (test/adversarial.test.ts) has to prove a real
// on-chain `revert`, deterministically, offline — no funded Base Sepolia
// wallet, no Pimlico bundler, no dependence on a live network being up
// during CI. Ganache's `provider()` gives an in-process EIP-1193 provider
// (no separate process, no port) that viem can use directly as a transport,
// and solc-js compiles our two contracts to real EVM bytecode without a
// native `solc` binary. This module owns that harness: compile, boot chain,
// deploy. Everything downstream (account.ts, sessionKeys.ts, reconcile.ts)
// just holds a PublicClient/WalletClient and doesn't know it's local.
//
// The production path (real Base Sepolia + Pimlico) lives in account.ts /
// sessionKeys.ts and is not exercised here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ganache from "ganache";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(__dirname, "../../contracts");

export const localGanacheChain = defineChain({
  id: 1337,
  name: "local-ganache",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
}

export interface Artifacts {
  MockUSDC: CompiledContract;
  SessionKeyVault: CompiledContract;
}

let cachedArtifacts: Artifacts | undefined;

/** Compiles contracts/*.sol via solc-js. Pure, deterministic, no network. */
export function compileContracts(): Artifacts {
  if (cachedArtifacts) return cachedArtifacts;

  const sources = {
    "MockUSDC.sol": { content: readFileSync(path.join(CONTRACTS_DIR, "MockUSDC.sol"), "utf8") },
    "SessionKeyVault.sol": {
      content: readFileSync(path.join(CONTRACTS_DIR, "SessionKeyVault.sol"), "utf8"),
    },
  };

  const input = {
    language: "Solidity",
    sources,
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const raw = solc.compile(JSON.stringify(input));
  const output = JSON.parse(raw);

  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Solidity compilation failed:\n${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")}`
    );
  }

  const usdc = output.contracts["MockUSDC.sol"]["MockUSDC"];
  const vault = output.contracts["SessionKeyVault.sol"]["SessionKeyVault"];

  cachedArtifacts = {
    MockUSDC: { abi: usdc.abi, bytecode: `0x${usdc.evm.bytecode.object}` as Hex },
    SessionKeyVault: { abi: vault.abi, bytecode: `0x${vault.evm.bytecode.object}` as Hex },
  };
  return cachedArtifacts;
}

// ---------------------------------------------------------------------------
// Chain lifecycle
// ---------------------------------------------------------------------------

export interface LocalAccount {
  privateKey: Hex;
  account: PrivateKeyAccount;
}

function fundedAccount(): LocalAccount {
  const privateKey = generatePrivateKey();
  return { privateKey, account: privateKeyToAccount(privateKey) };
}

export interface LocalChain {
  publicClient: PublicClient;
  /** Every call goes through the same in-process provider — cheap to make one per signer. */
  walletClientFor(account: PrivateKeyAccount): WalletClient;
  deployer: LocalAccount;
  /** Extra pre-funded accounts for use as vault owners, relayers, counterparties. */
  accounts: LocalAccount[];
  artifacts: Artifacts;
  usdcAddress: Address;
  mintUSDC(to: Address, amount: bigint): Promise<void>;
  deployVault(owner: Address): Promise<Address>;
}

export async function startLocalChain(extraAccountCount = 10): Promise<LocalChain> {
  const artifacts = compileContracts();

  const deployer = fundedAccount();
  const accounts = Array.from({ length: extraAccountCount }, fundedAccount);
  const allAccounts = [deployer, ...accounts];

  const provider = Ganache.provider({
    wallet: {
      accounts: allAccounts.map((a) => ({ secretKey: a.privateKey, balance: "0x21E19E0C9BAB2400000" })), // 10,000 ETH
    },
    logging: { quiet: true },
    chain: { chainId: localGanacheChain.id },
  });

  const publicClient = createPublicClient({
    chain: localGanacheChain,
    // ganache's provider is a real EIP-1193 provider; viem's `custom`
    // transport is the documented way to wrap one directly (no HTTP hop).
    transport: custom(provider),
  }) as unknown as PublicClient;

  function walletClientFor(account: PrivateKeyAccount): WalletClient {
    return createWalletClient({
      account,
      chain: localGanacheChain,
      transport: custom(provider),
    });
  }

  const deployerWallet = walletClientFor(deployer.account);

  async function deployAndWait(compiled: CompiledContract, args: unknown[]): Promise<Address> {
    const hash = await deployerWallet.deployContract({
      abi: compiled.abi,
      bytecode: compiled.bytecode,
      args,
      account: deployer.account,
      chain: localGanacheChain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment produced no contract address");
    return getAddress(receipt.contractAddress);
  }

  const usdcAddress = await deployAndWait(artifacts.MockUSDC, []);

  async function mintUSDC(to: Address, amount: bigint): Promise<void> {
    const hash = await deployerWallet.writeContract({
      address: usdcAddress,
      abi: artifacts.MockUSDC.abi,
      functionName: "mint",
      args: [to, amount],
      account: deployer.account,
      chain: localGanacheChain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function deployVault(owner: Address): Promise<Address> {
    return deployAndWait(artifacts.SessionKeyVault, [owner, usdcAddress]);
  }

  return {
    publicClient,
    walletClientFor,
    deployer,
    accounts,
    artifacts,
    usdcAddress,
    mintUSDC,
    deployVault,
  };
}
