// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PQSig} from "@pqc-forge/PQSig.sol";

/// @title Tollgate ChannelEscrow
/// @notice Pay-per-call payment channels for AI agents on QoreChain, secured by ML-DSA-87.
///
///  - A payer (the owner's account, usually acting through a linked agent key whose spending rules
///    cap per-tx and daily outflow) opens a channel to a provider with a native-QOR deposit.
///  - The agent signs CUMULATIVE vouchers off-chain with its ML-DSA-87 key ("I have authorised at most N
///    wei to this provider on this channel"). Thousands of calls cost no gas. The provider settles any time
///    with the latest voucher: ONE on-chain verification for any number of calls.
///  - Recipients: spending rules cannot restrict recipients, so the escrow does. A channel can only be
///    opened to a provider the owner allowlisted with an ML-DSA-87 signature, which a prompt-injected
///    agent cannot produce.
///  - The voucher key is pinned (keccak of the registered key) at open; possession must be proven.
///  - Exit: the payer starts an exit; the provider can still claim during the challenge period; then the
///    remainder is refunded. A provider can also close early and refund the payer.
contract ChannelEscrow is ReentrancyGuard {
    using Strings for uint256;
    using Strings for address;

    struct Channel {
        address payer;
        address provider;
        address voucherSigner;
        bytes32 keyHash; // keccak256 of the voucher signer's registered ML-DSA-87 public key, pinned at open
        uint128 deposit; // wei
        uint128 paid; // wei, = latest settled cumulative voucher
        uint64 exitAt; // 0 = no exit pending
        bool closed;
    }

    uint256 public immutable challengePeriod;
    Channel[] private channels;

    mapping(address owner => mapping(address provider => bool)) public providerAllowed;
    mapping(address owner => uint256) public providerNonce;

    event ProviderSet(address indexed owner, address indexed provider, bool allowed, uint256 nonce);
    event ChannelOpened(uint256 indexed id, address indexed payer, address indexed provider, address voucherSigner, uint256 deposit);
    event ToppedUp(uint256 indexed id, uint256 amount, uint256 deposit);
    event Claimed(uint256 indexed id, uint256 cumulative, uint256 amount);
    event ExitStarted(uint256 indexed id, uint64 exitAt);
    event Closed(uint256 indexed id, uint256 paid, uint256 refunded);

    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 got);
    error ProviderNotAllowed(address provider);
    error ZeroDeposit();
    error NotPayer();
    error NotProvider();
    error ChannelClosed(uint256 id);
    error ExitPending(uint256 id);
    error NoExitPending(uint256 id);
    error ChallengePeriodActive(uint64 exitAt);
    error NotIncreasing(uint256 paid, uint256 cumulative);
    error ExceedsDeposit(uint256 deposit, uint256 cumulative);
    error VoucherKeyChanged(address voucherSigner);
    error TransferFailed();
    error UnknownChannel(uint256 id);

    constructor(uint256 challengePeriod_) {
        challengePeriod = challengePeriod_;
    }

    // ------------------------------------------------------------------ provider allowlist (owner, ML-DSA-87)

    /// @notice Allow or disallow `provider` for `owner`, authorised by the owner's ML-DSA-87 signature over
    ///         `providerText` (QoreSign message-signing-v1). Anyone may relay it.
    function setProvider(address owner, address provider, bool allowed, uint256 nonce, bytes calldata ownerSig) external {
        uint256 expected = providerNonce[owner];
        if (nonce != expected) revert InvalidNonce(expected, nonce);
        if (!PQSig.verifyMessageBy(owner, providerText(owner, provider, allowed, nonce), ownerSig)) revert InvalidSignature();
        providerNonce[owner] = expected + 1;
        providerAllowed[owner][provider] = allowed;
        emit ProviderSet(owner, provider, allowed, nonce);
    }

    // ------------------------------------------------------------------ channel lifecycle

    /// @notice Open a channel to an allowlisted provider. Vouchers must be signed by `voucherSigner`'s
    ///         registered ML-DSA-87 key (possession proven), which is pinned now.
    function open(address provider, address voucherSigner) external payable returns (uint256 id) {
        if (!providerAllowed[msg.sender][provider]) revert ProviderNotAllowed(provider);
        if (msg.value == 0) revert ZeroDeposit();
        bytes32 keyHash = keccak256(PQSig.registeredKey(voucherSigner));
        id = channels.length;
        channels.push(Channel(msg.sender, provider, voucherSigner, keyHash, uint128(msg.value), 0, 0, false));
        emit ChannelOpened(id, msg.sender, provider, voucherSigner, msg.value);
    }

    function topUp(uint256 id) external payable {
        Channel storage c = _live(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (c.exitAt != 0) revert ExitPending(id);
        if (msg.value == 0) revert ZeroDeposit();
        c.deposit += uint128(msg.value);
        emit ToppedUp(id, msg.value, c.deposit);
    }

    /// @notice Settle the latest cumulative voucher. Anyone may submit it; funds always go to the provider.
    function claim(uint256 id, uint256 cumulative, bytes calldata voucherSig) external nonReentrant {
        Channel storage c = _live(id);
        if (cumulative <= c.paid) revert NotIncreasing(c.paid, cumulative);
        if (cumulative > c.deposit) revert ExceedsDeposit(c.deposit, cumulative);
        bytes memory pk = PQSig.registeredKey(c.voucherSigner);
        if (keccak256(pk) != c.keyHash) revert VoucherKeyChanged(c.voucherSigner);
        if (!PQSig.verify(pk, voucherSig, PQSig.messageBytes(voucherText(id, cumulative)))) revert InvalidSignature();

        uint256 amount = cumulative - c.paid;
        c.paid = uint128(cumulative);
        emit Claimed(id, cumulative, amount);
        _send(c.provider, amount);
    }

    /// @notice Payer starts an exit. The provider keeps `challengePeriod` seconds to claim its latest voucher.
    function startExit(uint256 id) external {
        Channel storage c = _live(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (c.exitAt != 0) revert ExitPending(id);
        c.exitAt = uint64(block.timestamp + challengePeriod);
        emit ExitStarted(id, c.exitAt);
    }

    /// @notice After the challenge period, refund the unclaimed deposit to the payer. Anyone may call.
    function finalizeExit(uint256 id) external nonReentrant {
        Channel storage c = _live(id);
        if (c.exitAt == 0) revert NoExitPending(id);
        if (block.timestamp < c.exitAt) revert ChallengePeriodActive(c.exitAt);
        _close(id, c);
    }

    /// @notice The provider is done: close now and refund the payer (after claiming, if it wants).
    function closeByProvider(uint256 id) external nonReentrant {
        Channel storage c = _live(id);
        if (msg.sender != c.provider) revert NotProvider();
        _close(id, c);
    }

    // ------------------------------------------------------------------ views

    function channelCount() external view returns (uint256) {
        return channels.length;
    }

    function channel(uint256 id) external view returns (Channel memory) {
        if (id >= channels.length) revert UnknownChannel(id);
        return channels[id];
    }

    /// @notice The exact text an agent signs for a voucher (the `data` of QoreSign message-signing-v1).
    function voucherText(uint256 id, uint256 cumulative) public view returns (bytes memory) {
        Channel storage c = channels[id];
        return bytes.concat(
            "Tollgate voucher v1\n",
            "chain: ", bytes(block.chainid.toString()), "\n",
            "escrow: ", bytes(address(this).toHexString()), "\n",
            "channel: ", bytes(id.toString()), "\n",
            "provider: ", bytes(c.provider.toHexString()), "\n",
            "cumulative wei: ", bytes(cumulative.toString())
        );
    }

    /// @notice The exact text an owner signs to allow or disallow a provider.
    function providerText(address owner, address provider, bool allowed, uint256 nonce) public view returns (bytes memory) {
        return bytes.concat(
            "Tollgate provider v1\n",
            "chain: ", bytes(block.chainid.toString()), "\n",
            "escrow: ", bytes(address(this).toHexString()), "\n",
            "owner: ", bytes(owner.toHexString()), "\n",
            "provider: ", bytes(provider.toHexString()), "\n",
            "allowed: ", allowed ? bytes("true") : bytes("false"), "\n",
            "nonce: ", bytes(nonce.toString())
        );
    }

    // ------------------------------------------------------------------ internals

    function _live(uint256 id) private view returns (Channel storage c) {
        if (id >= channels.length) revert UnknownChannel(id);
        c = channels[id];
        if (c.closed) revert ChannelClosed(id);
    }

    function _close(uint256 id, Channel storage c) private {
        c.closed = true;
        uint256 refund = c.deposit - c.paid;
        emit Closed(id, c.paid, refund);
        if (refund > 0) _send(c.payer, refund);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
