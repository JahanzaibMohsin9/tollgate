// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PQSig} from "@pqc-forge/PQSig.sol";

/// @title Tollgate ChannelEscrow
/// @notice Pay-per-call payment channels for AI agents on QoreChain, secured by ML-DSA-87.
///
///  - The OWNER approves (provider, voucher signer) pairs with an ML-DSA-87 signature. Spending rules cannot
///    restrict recipients, so the escrow does: a prompt-injected agent can neither pay an unapproved provider
///    nor pick its own voucher signer (e.g. the provider itself).
///  - A payer (the owner's account, usually acting through a linked agent key bounded by on-chain spending
///    rules) opens a channel with a native-QOR deposit. The approved voucher signer's registered ML-DSA-87 key
///    (possession proven) is PINNED at open and emitted in ChannelOpened.
///  - The agent signs CUMULATIVE vouchers off-chain. The provider settles any time with the latest one: ONE
///    on-chain verification for any number of calls. Claims verify against the PINNED key (passed in calldata,
///    checked against its hash), so rotating or deregistering the voucher account's key cannot void vouchers
///    the provider already earned.
///  - Exit: the payer starts it; the provider keeps `challengePeriod` to claim; then the rest is refunded.
contract ChannelEscrow is ReentrancyGuard {
    using Strings for uint256;
    using Strings for address;

    struct Channel {
        address payer;
        address provider;
        address voucherSigner;
        bytes32 keyHash; // keccak256 of the voucher signer's ML-DSA-87 public key, pinned at open
        uint128 deposit; // wei
        uint128 paid; // wei, = latest settled cumulative voucher (capped at deposit)
        uint64 exitAt; // 0 = no exit pending
        bool closed;
    }

    uint256 public constant MIN_CHALLENGE_PERIOD = 1 minutes;
    uint256 public constant MAX_CHALLENGE_PERIOD = 30 days;
    uint256 public immutable challengePeriod;
    Channel[] private channels;

    /// owner => provider => approved voucher signer (address(0) = provider not allowed)
    mapping(address owner => mapping(address provider => address)) public approvedSigner;
    mapping(address owner => uint256) public providerNonce;
    /// payer => provider => latest channel id + 1 (0 = none). Logs emitted inside x/abstractaccount
    /// MsgExecuteEVM are not indexed by eth_getLogs on QoreChain today, so agents look channels up here.
    mapping(address payer => mapping(address provider => uint256)) private latestPlusOne;

    event ProviderSet(address indexed owner, address indexed provider, address voucherSigner, uint256 nonce);
    event ChannelOpened(
        uint256 indexed id, address indexed payer, address indexed provider, address voucherSigner, uint256 deposit, bytes voucherKey
    );
    event ToppedUp(uint256 indexed id, uint256 amount, uint256 deposit);
    event Claimed(uint256 indexed id, uint256 cumulative, uint256 amount);
    event ExitStarted(uint256 indexed id, uint64 exitAt);
    event Closed(uint256 indexed id, uint256 paid, uint256 refunded);

    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 got);
    error SignatureExpired(uint256 deadline);
    error ProviderNotAllowed(address provider);
    error ZeroDeposit();
    error NotPayer();
    error NotProvider();
    error ChannelClosed(uint256 id);
    error ExitPending(uint256 id);
    error NoExitPending(uint256 id);
    error ChallengePeriodActive(uint64 exitAt);
    error NotIncreasing(uint256 paid, uint256 due);
    error WrongVoucherKey(uint256 id);
    error TransferFailed();
    error UnknownChannel(uint256 id);
    error BadChallengePeriod(uint256 challengePeriod);

    constructor(uint256 challengePeriod_) {
        if (challengePeriod_ < MIN_CHALLENGE_PERIOD || challengePeriod_ > MAX_CHALLENGE_PERIOD) {
            revert BadChallengePeriod(challengePeriod_);
        }
        challengePeriod = challengePeriod_;
    }

    // ------------------------------------------------------------------ provider approval (owner, ML-DSA-87)

    /// @notice Approve `provider` with `voucherSigner` (or revoke with voucherSigner = address(0)) for `owner`,
    ///         authorised by the owner's ML-DSA-87 signature over `providerText`. Anyone may relay it.
    function setProvider(address owner, address provider, address voucherSigner, uint256 nonce, uint256 deadline, bytes calldata ownerSig)
        external
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        uint256 expected = providerNonce[owner];
        if (nonce != expected) revert InvalidNonce(expected, nonce);
        if (!PQSig.verifyMessageBy(owner, providerText(owner, provider, voucherSigner, nonce, deadline), ownerSig)) {
            revert InvalidSignature();
        }
        providerNonce[owner] = expected + 1;
        approvedSigner[owner][provider] = voucherSigner;
        emit ProviderSet(owner, provider, voucherSigner, nonce);
    }

    // ------------------------------------------------------------------ channel lifecycle

    /// @notice Open a channel to an owner-approved provider. The voucher signer is the one the owner approved.
    function open(address provider) external payable returns (uint256 id) {
        address voucherSigner = approvedSigner[msg.sender][provider];
        if (voucherSigner == address(0)) revert ProviderNotAllowed(provider);
        if (msg.value == 0) revert ZeroDeposit();
        bytes memory key = PQSig.registeredKey(voucherSigner); // registered, ML-DSA-87, possession proven
        id = channels.length;
        channels.push(Channel(msg.sender, provider, voucherSigner, keccak256(key), SafeCast.toUint128(msg.value), 0, 0, false));
        latestPlusOne[msg.sender][provider] = id + 1;
        emit ChannelOpened(id, msg.sender, provider, voucherSigner, msg.value, key);
    }

    function topUp(uint256 id) external payable {
        Channel storage c = _live(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (c.exitAt != 0) revert ExitPending(id);
        if (msg.value == 0) revert ZeroDeposit();
        c.deposit = SafeCast.toUint128(uint256(c.deposit) + msg.value);
        emit ToppedUp(id, msg.value, c.deposit);
    }

    /// @notice Settle a cumulative voucher (capped at the deposit). Anyone may submit; funds go to the provider.
    /// @param voucherKey the ML-DSA-87 public key pinned at open (see ChannelOpened)
    function claim(uint256 id, uint256 cumulative, bytes calldata voucherKey, bytes calldata voucherSig) external nonReentrant {
        Channel storage c = _live(id);
        if (keccak256(voucherKey) != c.keyHash) revert WrongVoucherKey(id);
        if (!PQSig.verify(voucherKey, voucherSig, PQSig.messageBytes(voucherText(id, cumulative)))) revert InvalidSignature();
        uint256 due = cumulative < c.deposit ? cumulative : c.deposit;
        if (due <= c.paid) revert NotIncreasing(c.paid, due);

        uint256 amount = due - c.paid;
        c.paid = uint128(due); // due <= deposit, which fits uint128
        emit Claimed(id, due, amount);
        _send(c.provider, amount);
    }

    /// @notice Payer starts an exit. The provider keeps `challengePeriod` seconds to claim its latest voucher.
    function startExit(uint256 id) external {
        Channel storage c = _live(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (c.exitAt != 0) revert ExitPending(id);
        c.exitAt = SafeCast.toUint64(block.timestamp + challengePeriod);
        emit ExitStarted(id, c.exitAt);
    }

    /// @notice After the challenge period, refund the unclaimed deposit to the payer. Anyone may call.
    /// @dev At exactly `exitAt` (and until someone finalizes) the provider can still claim: ties favour the provider.
    function finalizeExit(uint256 id) external nonReentrant {
        Channel storage c = _live(id);
        if (c.exitAt == 0) revert NoExitPending(id);
        if (block.timestamp < c.exitAt) revert ChallengePeriodActive(c.exitAt);
        _close(id, c);
    }

    /// @notice The provider is done: close now and refund the payer (claim first if it wants).
    function closeByProvider(uint256 id) external nonReentrant {
        Channel storage c = _live(id);
        if (msg.sender != c.provider) revert NotProvider();
        _close(id, c);
    }

    // ------------------------------------------------------------------ views

    /// @notice The most recent channel `payer` opened to `provider`.
    function lastChannel(address payer, address provider) external view returns (bool exists, uint256 id) {
        uint256 v = latestPlusOne[payer][provider];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    function channelCount() external view returns (uint256) {
        return channels.length;
    }

    function channel(uint256 id) external view returns (Channel memory) {
        if (id >= channels.length) revert UnknownChannel(id);
        return channels[id];
    }

    /// @notice The exact text an agent signs for a voucher (the `data` of QoreSign message-signing-v1).
    function voucherText(uint256 id, uint256 cumulative) public view returns (bytes memory) {
        if (id >= channels.length) revert UnknownChannel(id);
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

    /// @notice The exact text an owner signs to approve (voucherSigner != 0) or revoke (0) a provider.
    function providerText(address owner, address provider, address voucherSigner, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes memory)
    {
        return bytes.concat(
            "Tollgate provider v1\n",
            "chain: ", bytes(block.chainid.toString()), "\n",
            "escrow: ", bytes(address(this).toHexString()), "\n",
            "owner: ", bytes(owner.toHexString()), "\n",
            "provider: ", bytes(provider.toHexString()), "\n",
            "voucher signer: ", bytes(voucherSigner.toHexString()), "\n",
            "nonce: ", bytes(nonce.toString()), "\n",
            "valid until: ", bytes(deadline.toString())
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
