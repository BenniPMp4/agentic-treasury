// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title SessionKeyVault
/// @notice One instance per agent. Stands in for a Kernel/ERC-4337 smart
/// account plus its session-key permission validator plugin (see
/// PHASE2.md "Entitlement -> session key mapping"). The owner (the
/// treasury backend) issues and revokes session keys, but this contract
/// — not the backend, not the policy engine — is what actually enforces
/// cap, expiry, target allowlist, revocation and replay protection on
/// every spend. Invariant 11: the chain is authoritative for what was
/// spent.
///
/// In production this logic is expressed as ZeroDev Kernel permission
/// policies (toCallPolicy / toTimestampPolicy / a spend-cap policy) on a
/// real Kernel smart account, submitted as ERC-4337 UserOperations through
/// a Pimlico bundler — see src/chain/account.ts and src/chain/sessionKeys.ts.
/// This contract is the same permission table, deployed directly to a
/// local chain, so the adversarial test suite gets deterministic, offline,
/// real EVM reverts instead of depending on a live bundler and a funded
/// testnet wallet.
contract SessionKeyVault {
    struct Session {
        uint256 cap;        // amount_granted, cumulative, minor units
        uint256 spent;      // amount_spent so far
        uint64  validUntil; // expires_at, unix seconds
        bool    restricted; // false => counterparty_allow was empty (allow all)
        bool    revoked;
        uint256 nonce;      // next expected nonce — sequential replay guard
    }

    address public immutable owner;
    IERC20  public immutable usdc;

    mapping(address => Session) public sessions;
    mapping(address => mapping(address => bool)) public allowedTarget;

    event SessionIssued(address indexed sessionKey, uint256 cap, uint64 validUntil);
    event SessionRevoked(address indexed sessionKey, uint256 unspent);
    event Spent(address indexed sessionKey, address indexed target, uint256 amount, uint256 nonce);

    error NotOwner();
    error SessionRevokedErr();
    error SessionExpired();
    error TargetNotAllowed();
    error CapExceeded();
    error BadNonce();
    error BadSignature();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, address _usdc) {
        owner = _owner;
        usdc = IERC20(_usdc);
    }

    /// @dev Re-issuing a session key resets its spent/nonce counters —
    /// callers should mint a fresh key per entitlement rather than reuse
    /// addresses, but a reset-on-issue keeps the contract's own state
    /// consistent either way.
    function issueSessionKey(
        address sessionKey,
        uint256 cap,
        uint64 validUntil,
        address[] calldata allowedTargets
    ) external onlyOwner {
        Session storage s = sessions[sessionKey];
        s.cap = cap;
        s.spent = 0;
        s.validUntil = validUntil;
        s.revoked = false;
        s.nonce = 0;
        s.restricted = allowedTargets.length > 0;
        for (uint256 i = 0; i < allowedTargets.length; i++) {
            allowedTarget[sessionKey][allowedTargets[i]] = true;
        }
        emit SessionIssued(sessionKey, cap, validUntil);
    }

    function revokeSessionKey(address sessionKey) external onlyOwner returns (uint256 unspent) {
        Session storage s = sessions[sessionKey];
        unspent = s.cap > s.spent ? s.cap - s.spent : 0;
        s.revoked = true;
        emit SessionRevoked(sessionKey, unspent);
    }

    /// @notice Executes a session-key-authorised spend. Anyone may call
    /// this (relayer, bundler, backend) — the security boundary is the
    /// session key's signature plus the checks below, never msg.sender.
    /// Reverts with a typed error on any violation; never silently no-ops.
    function execute(
        address sessionKey,
        address target,
        uint256 amount,
        uint256 nonce,
        bytes calldata signature
    ) external {
        Session storage s = sessions[sessionKey];

        if (s.revoked) revert SessionRevokedErr();
        if (block.timestamp > s.validUntil) revert SessionExpired();
        if (s.restricted && !allowedTarget[sessionKey][target]) revert TargetNotAllowed();
        if (nonce != s.nonce) revert BadNonce();
        if (s.spent + amount > s.cap) revert CapExceeded();

        bytes32 digest = keccak256(
            abi.encode(address(this), block.chainid, sessionKey, nonce, target, amount)
        );
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        if (_recover(ethSigned, signature) != sessionKey) revert BadSignature();

        s.spent += amount;
        s.nonce += 1;

        require(usdc.transfer(target, amount), "USDC_TRANSFER_FAILED");
        emit Spent(sessionKey, target, amount, nonce);
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
