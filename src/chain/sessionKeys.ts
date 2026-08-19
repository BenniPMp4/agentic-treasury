// Issue, revoke, and query session keys from entitlements.
//
// This is the concrete realisation of PHASE2.md's "Entitlement -> session
// key mapping" table against the SessionKeyVault contract (see
// contracts/SessionKeyVault.sol and src/chain/localChain.ts): every check
// here happens on chain, in the vault's `execute`, not in this file. This
// module only builds the signed operation and relays it — the enforcement
// is the contract's, which is the entire point (see PHASE2.md's "new
// invariant" and the adversarial suite).
//
// In production the same table is expressed as ZeroDev Kernel permission
// policies on a real smart account (see account.ts); this file's
// vault-based path is what's actually exercised by the test suite, per
// the "no live bundler in CI" decision documented in README.md.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface SessionKeyChainDeps {
  publicClient: PublicClient;
  vaultAbi: Abi;
}

export interface SessionKeyRecord {
  entitlement_id: string;
  agent_id: string;
  vault: Address;
  session_key: Address;
  session_key_private_key: Hex;
}

/** entitlement_id <-> session key, kept off chain. See PHASE2.md: "Delegation
 * stays off-chain." This registry is what lets reconcile.ts tell a spend
 * it recognises from one it doesn't (invariant 11's third case). */
export class SessionKeyRegistry {
  private byEntitlement = new Map<string, SessionKeyRecord>();
  private bySessionKey = new Map<string, SessionKeyRecord>();

  add(record: SessionKeyRecord): void {
    this.byEntitlement.set(record.entitlement_id, record);
    this.bySessionKey.set(record.session_key.toLowerCase(), record);
  }

  getByEntitlement(entitlementId: string): SessionKeyRecord | undefined {
    return this.byEntitlement.get(entitlementId);
  }

  getBySessionKey(sessionKey: Address): SessionKeyRecord | undefined {
    return this.bySessionKey.get(sessionKey.toLowerCase());
  }

  remove(entitlementId: string): void {
    const record = this.byEntitlement.get(entitlementId);
    if (!record) return;
    this.byEntitlement.delete(entitlementId);
    this.bySessionKey.delete(record.session_key.toLowerCase());
  }

  all(): SessionKeyRecord[] {
    return [...this.byEntitlement.values()];
  }
}

export interface IssueSessionKeyParams {
  entitlementId: string;
  agentId: string;
  vault: Address;
  amountGranted: bigint;
  /** epoch millis, matches Entitlement.expires_at */
  expiresAtMs: number;
  /** entitlement.counterparty_allow, as addresses; empty = allow all */
  counterpartyAllow: Address[];
  chain: SessionKeyChainDeps;
  registry: SessionKeyRegistry;
  ownerWallet: WalletClient;
  ownerAccount: PrivateKeyAccount;
}

export async function issueSessionKeyForEntitlement(
  params: IssueSessionKeyParams
): Promise<SessionKeyRecord & { tx_hash: Hex }> {
  const sessionKeyPrivateKey = generatePrivateKey();
  const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivateKey);
  const validUntil = BigInt(Math.floor(params.expiresAtMs / 1000));

  // Simulate first (rather than just writeContract-and-hope) so a rejected
  // issuance — e.g. someone other than the vault's owner attempting it —
  // throws here with a decodable reason instead of silently mining a
  // reverted transaction that this function would otherwise report as
  // success.
  const { request } = await params.chain.publicClient.simulateContract({
    address: params.vault,
    abi: params.chain.vaultAbi,
    functionName: "issueSessionKey",
    args: [sessionKeyAccount.address, params.amountGranted, validUntil, params.counterpartyAllow],
    account: params.ownerAccount,
  });
  const hash = await params.ownerWallet.writeContract(request);
  await params.chain.publicClient.waitForTransactionReceipt({ hash });

  const record: SessionKeyRecord = {
    entitlement_id: params.entitlementId,
    agent_id: params.agentId,
    vault: params.vault,
    session_key: sessionKeyAccount.address,
    session_key_private_key: sessionKeyPrivateKey,
  };
  params.registry.add(record);

  return { ...record, tx_hash: hash };
}

export interface RevokeSessionKeyParams {
  entitlementId: string;
  chain: SessionKeyChainDeps;
  registry: SessionKeyRegistry;
  ownerWallet: WalletClient;
  ownerAccount: PrivateKeyAccount;
}

export async function revokeSessionKeyForEntitlement(
  params: RevokeSessionKeyParams
): Promise<{ returned_amount: bigint; tx_hash: Hex }> {
  const record = params.registry.getByEntitlement(params.entitlementId);
  if (!record) throw new Error(`No session key registered for entitlement ${params.entitlementId}`);

  const { result, request } = await params.chain.publicClient.simulateContract({
    address: record.vault,
    abi: params.chain.vaultAbi,
    functionName: "revokeSessionKey",
    args: [record.session_key],
    account: params.ownerAccount,
  });

  const hash = await params.ownerWallet.writeContract(request);
  await params.chain.publicClient.waitForTransactionReceipt({ hash });
  params.registry.remove(params.entitlementId);

  return { returned_amount: result as bigint, tx_hash: hash };
}

export interface OnChainSession {
  cap: bigint;
  spent: bigint;
  validUntil: bigint;
  restricted: boolean;
  revoked: boolean;
  nonce: bigint;
}

export async function readSession(
  chain: SessionKeyChainDeps,
  vault: Address,
  sessionKey: Address
): Promise<OnChainSession> {
  const result = (await chain.publicClient.readContract({
    address: vault,
    abi: chain.vaultAbi,
    functionName: "sessions",
    args: [sessionKey],
  })) as readonly [bigint, bigint, bigint, boolean, boolean, bigint];
  const [cap, spent, validUntil, restricted, revoked, nonce] = result;
  return { cap, spent, validUntil, restricted, revoked, nonce };
}

/** Builds the digest the vault expects: keccak256(abi.encode(vault, chainId,
 * sessionKey, nonce, target, amount)), matching contract/SessionKeyVault.sol
 * `execute` exactly. */
async function buildDigest(
  chain: SessionKeyChainDeps,
  vault: Address,
  sessionKey: Address,
  nonce: bigint,
  target: Address,
  amount: bigint
): Promise<Hex> {
  const chainId = BigInt(await chain.publicClient.getChainId());
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
    ],
    [vault, chainId, sessionKey, nonce, target, amount]
  );
  return keccak256(encoded);
}

export interface SpendViaSessionKeyParams {
  record: SessionKeyRecord;
  target: Address;
  amount: bigint;
  chain: SessionKeyChainDeps;
  relayerWallet: WalletClient;
  relayerAccount: PrivateKeyAccount;
}

/**
 * Signs and relays a spend. Simulates first (so a violation surfaces as a
 * decoded revert here, before any transaction is sent) then sends the real
 * tx and waits for it to mine. Throws on revert — callers that need to
 * assert on the specific rejection should use `attemptSpend` instead, or
 * catch and pass the error to `decodeVaultRevert`.
 */
export async function spendViaSessionKey(
  params: SpendViaSessionKeyParams
): Promise<{ tx_hash: Hex; nonce: bigint }> {
  const session = await readSession(params.chain, params.record.vault, params.record.session_key);
  const sessionAccount = privateKeyToAccount(params.record.session_key_private_key);

  const digest = await buildDigest(
    params.chain,
    params.record.vault,
    params.record.session_key,
    session.nonce,
    params.target,
    params.amount
  );
  const signature = await sessionAccount.signMessage({ message: { raw: digest } });

  const { request } = await params.chain.publicClient.simulateContract({
    address: params.record.vault,
    abi: params.chain.vaultAbi,
    functionName: "execute",
    args: [params.record.session_key, params.target, params.amount, session.nonce, signature],
    account: params.relayerAccount,
  });

  const hash = await params.relayerWallet.writeContract(request);
  await params.chain.publicClient.waitForTransactionReceipt({ hash });

  return { tx_hash: hash, nonce: session.nonce };
}

export type SpendAttempt =
  | { ok: true; tx_hash: Hex; nonce: bigint }
  | { ok: false; revert_reason: string };

/** Same as `spendViaSessionKey` but never throws — used by the adversarial
 * suite, which needs to assert on *which* on-chain revert fired. */
export async function attemptSpend(params: SpendViaSessionKeyParams): Promise<SpendAttempt> {
  try {
    const result = await spendViaSessionKey(params);
    return { ok: true, ...result };
  } catch (error) {
    const reason = decodeVaultRevert(error, params.chain.vaultAbi);
    if (reason === undefined) throw error; // not a decodable contract revert — a real bug, don't swallow it
    return { ok: false, revert_reason: reason };
  }
}

/** Pulls the vault's custom error name (e.g. "CapExceeded") out of a viem
 * error, however deep it's wrapped. Returns undefined for anything that
 * isn't a decoded contract revert.
 *
 * Two paths, because providers disagree on error shape:
 *  - Against a real node (or anvil), viem recognises the JSON-RPC error
 *    message text itself ("execution reverted") and produces a
 *    ContractFunctionRevertedError with the ABI-decoded error already on
 *    it — that's the fast path below.
 *  - Ganache's VM error text ("VM Exception while processing transaction:
 *    revert") doesn't match viem's `execution reverted` detection, so viem
 *    gives up and never builds a ContractFunctionRevertedError, even though
 *    the raw revert selector is right there on the underlying RPC error's
 *    `data` field. The fallback below walks the cause chain for that raw
 *    hex and decodes it against the vault ABI ourselves.
 */
export function decodeVaultRevert(error: unknown, abi: Abi): string | undefined {
  if (!(error instanceof BaseError)) return undefined;

  const revertError = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revertError instanceof ContractFunctionRevertedError) {
    const name = revertError.data?.errorName ?? revertError.reason;
    if (name) return name;
  }

  const rawData = findRawRevertData(error);
  if (!rawData) return undefined;
  try {
    return decodeErrorResult({ abi, data: rawData }).errorName;
  } catch {
    return undefined;
  }
}

function findRawRevertData(error: BaseError): Hex | undefined {
  const withData = error.walk(
    (e) => typeof (e as { data?: unknown })?.data === "string" && (e as { data: string }).data !== "0x"
  );
  if (withData && typeof (withData as { data?: unknown }).data === "string") {
    return (withData as unknown as { data: Hex }).data;
  }
  return undefined;
}

/** Re-issuing with a fresh signed payload but the *same* nonce is exactly
 * what a replay looks like on chain (test 6). Callers construct one of
 * these by calling `spendViaSessionKey` once, then calling `attemptSpend`
 * again with the identical `nonce` captured from the first call's digest —
 * see test/adversarial.test.ts for the exact construction, since replay
 * requires reusing the raw signature bytes, not just the nonce. */
export async function signSpend(
  chain: SessionKeyChainDeps,
  record: SessionKeyRecord,
  target: Address,
  amount: bigint,
  nonce: bigint
): Promise<Hex> {
  const digest = await buildDigest(chain, record.vault, record.session_key, nonce, target, amount);
  const sessionAccount = privateKeyToAccount(record.session_key_private_key);
  return sessionAccount.signMessage({ message: { raw: digest } });
}

/** Relays a pre-signed operation as-is — no fresh signing, no nonce lookup.
 * This is what a replay attempt actually is: the exact same signed bytes,
 * sent again. */
export async function relaySignedSpend(params: {
  record: SessionKeyRecord;
  target: Address;
  amount: bigint;
  nonce: bigint;
  signature: Hex;
  chain: SessionKeyChainDeps;
  relayerWallet: WalletClient;
  relayerAccount: PrivateKeyAccount;
}): Promise<SpendAttempt> {
  try {
    const { request } = await params.chain.publicClient.simulateContract({
      address: params.record.vault,
      abi: params.chain.vaultAbi,
      functionName: "execute",
      args: [params.record.session_key, params.target, params.amount, params.nonce, params.signature],
      account: params.relayerAccount,
    });
    const hash = await params.relayerWallet.writeContract(request);
    await params.chain.publicClient.waitForTransactionReceipt({ hash });
    return { ok: true, tx_hash: hash, nonce: params.nonce };
  } catch (error) {
    const reason = decodeVaultRevert(error, params.chain.vaultAbi);
    if (reason === undefined) throw error;
    return { ok: false, revert_reason: reason };
  }
}
