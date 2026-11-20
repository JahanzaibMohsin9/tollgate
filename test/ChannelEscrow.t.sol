// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PqcForge} from "@pqc-forge/PqcForge.sol";
import {PQSig} from "@pqc-forge/PQSig.sol";
import {ChannelEscrow} from "../src/ChannelEscrow.sol";

contract RevertingPayer {
    receive() external payable {
        revert("no refunds");
    }

    function open(ChannelEscrow e, address provider) external payable returns (uint256) {
        return e.open{value: msg.value}(provider);
    }

    function startExit(ChannelEscrow e, uint256 id) external {
        e.startExit(id);
    }
}

contract ChannelEscrowTest is Test, PqcForge {
    ChannelEscrow escrow;
    uint256 constant CHALLENGE = 1 hours;

    address owner = makeAddr("owner"); // the payer (acts through its linked agent key on chain)
    address agentVoucher = makeAddr("agent-voucher-signer");
    address provider = makeAddr("provider");
    address attacker = makeAddr("attacker");
    PqcKey ownerKey;
    PqcKey agentKey;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(1_764_000_000);
        installPqc();
        escrow = new ChannelEscrow(CHALLENGE);
        ownerKey = pqcRegisterNew(owner, keccak256("owner"));
        agentKey = pqcRegisterNew(agentVoucher, keccak256("agent"));
        vm.deal(owner, 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _approve(address p, address signer) internal {
        uint256 n = escrow.providerNonce(owner);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, p, signer, n, deadline));
        escrow.setProvider(owner, p, signer, n, deadline, sig);
    }

    function _open(uint256 deposit) internal returns (uint256 id) {
        _approve(provider, agentVoucher);
        vm.prank(owner);
        id = escrow.open{value: deposit}(provider);
    }

    function _voucher(PqcKey memory k, uint256 id, uint256 cumulative) internal returns (bytes memory) {
        return pqcSignMessage(k, escrow.voucherText(id, cumulative));
    }

    function _claim(uint256 id, uint256 cumulative) internal {
        escrow.claim(id, cumulative, agentKey.publicKey, _voucher(agentKey, id, cumulative));
    }

    // ------------------------------------------------------------------ provider approval (owner, ML-DSA-87)

    function test_ownerApprovesProviderAndVoucherSigner() public {
        _approve(provider, agentVoucher);
        assertEq(escrow.approvedSigner(owner, provider), agentVoucher);
        assertEq(escrow.providerNonce(owner), 1);
    }

    function test_agentOrAttackerCannotApproveAProvider() public {
        bytes memory text = escrow.providerText(owner, attacker, attacker, 0, block.timestamp + 1 days);
        bytes memory forged = pqcSignMessage(agentKey, text); // the agent's ML-DSA key is not the owner's
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.setProvider(owner, attacker, attacker, 0, block.timestamp + 1 days, forged);
    }

    function test_approvalCannotBeReplayed() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, provider, agentVoucher, 0, deadline));
        escrow.setProvider(owner, provider, agentVoucher, 0, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.InvalidNonce.selector, 1, 0));
        escrow.setProvider(owner, provider, agentVoucher, 0, deadline, sig);
    }

    /// Review finding TG-9: an unrelayed approval must not stay valid forever.
    function test_staleApprovalExpires() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, provider, agentVoucher, 0, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.SignatureExpired.selector, deadline));
        escrow.setProvider(owner, provider, agentVoucher, 0, deadline, sig);
    }

    /// The approval binds the voucher signer: relaying it with another signer fails.
    function test_approvalBindsTheVoucherSigner() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, provider, agentVoucher, 0, deadline));
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.setProvider(owner, provider, provider, 0, deadline, sig); // try to make the provider its own signer
    }

    function test_ownerCanRevokeProvider() public {
        _approve(provider, agentVoucher);
        _approve(provider, address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ProviderNotAllowed.selector, provider));
        escrow.open{value: 1 ether}(provider);
    }

    // ------------------------------------------------------------------ open

    function test_promptInjectedAgentCannotOpenToAttacker() public {
        _approve(provider, agentVoucher);
        vm.prank(owner); // the agent acts as the owner's account through MsgExecuteEVM
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ProviderNotAllowed.selector, attacker));
        escrow.open{value: 1 ether}(attacker);
    }

    /// Review finding (jury A): the agent cannot choose the voucher signer anymore; the owner fixed it.
    function test_lastChannelLookup() public {
        (bool none,) = escrow.lastChannel(owner, provider);
        assertFalse(none);
        uint256 a = _open(1 ether);
        vm.prank(owner);
        uint256 b = escrow.open{value: 1 ether}(provider);
        (bool ok, uint256 id) = escrow.lastChannel(owner, provider);
        assertTrue(ok);
        assertEq(id, b);
        assertTrue(a != b);
    }

    function test_voucherSignerIsTheOwnerApprovedOne() public {
        uint256 id = _open(1 ether);
        assertEq(escrow.channel(id).voucherSigner, agentVoucher);
        assertEq(escrow.channel(id).keyHash, keccak256(agentKey.publicKey));
    }

    function test_openRequiresVoucherKeyWithPossessionProof() public {
        address copycat = makeAddr("copycat");
        pqcRegister(copycat, agentKey.publicKey, false);
        _approve(provider, copycat);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQSig.PqcPossessionNotProven.selector, copycat));
        escrow.open{value: 1 ether}(provider);
    }

    function test_openRequiresDeposit() public {
        _approve(provider, agentVoucher);
        vm.prank(owner);
        vm.expectRevert(ChannelEscrow.ZeroDeposit.selector);
        escrow.open(provider);
    }

    // ------------------------------------------------------------------ claim

    function test_oneClaimSettlesManyCalls() public {
        uint256 id = _open(1 ether);
        uint256 cumulative = 1000 * 0.0005 ether; // 1,000 calls happened off-chain
        vm.prank(provider);
        _claim(id, cumulative);
        assertEq(provider.balance, 0.5 ether);
        assertEq(escrow.channel(id).paid, 0.5 ether);
    }

    function test_incrementalClaimsPayOnlyTheDifference() public {
        uint256 id = _open(1 ether);
        _claim(id, 0.1 ether);
        _claim(id, 0.25 ether);
        assertEq(provider.balance, 0.25 ether);
    }

    function test_olderVoucherCannotBeSettledAgain() public {
        uint256 id = _open(1 ether);
        bytes memory old = _voucher(agentKey, id, 0.1 ether);
        _claim(id, 0.3 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.NotIncreasing.selector, 0.3 ether, 0.1 ether));
        escrow.claim(id, 0.1 ether, agentKey.publicKey, old);
    }

    /// Review finding TG-8: a voucher above the deposit settles up to the deposit instead of being worthless.
    function test_overDepositVoucherPaysTheDeposit() public {
        uint256 id = _open(1 ether);
        _claim(id, 2 ether);
        assertEq(provider.balance, 1 ether);
        assertEq(escrow.channel(id).paid, 1 ether);
    }

    function test_providerCannotForgeVoucher() public {
        uint256 id = _open(1 ether);
        PqcKey memory providerKey = pqcRegisterNew(provider, keccak256("provider"));
        bytes memory forged = _voucher(providerKey, id, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.WrongVoucherKey.selector, id));
        escrow.claim(id, 1 ether, providerKey.publicKey, forged); // its own key is not the pinned one
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(id, 1 ether, agentKey.publicKey, forged); // the pinned key does not verify its signature
    }

    function test_voucherIsBoundToItsChannel() public {
        uint256 a = _open(1 ether);
        vm.prank(owner);
        uint256 b = escrow.open{value: 1 ether}(provider);
        bytes memory forA = _voucher(agentKey, a, 0.5 ether);
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(b, 0.5 ether, agentKey.publicKey, forA);
    }

    function test_tamperedAmountFails() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.1 ether);
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(id, 0.9 ether, agentKey.publicKey, v);
    }

    /// Review finding TG-1 (High): rotating the voucher account's key after service must NOT void earned vouchers.
    function test_keyRotationCannotStrandEarnedVouchers() public {
        uint256 id = _open(1 ether);
        bytes memory earned = _voucher(agentKey, id, 0.4 ether); // provider served 0.4 QOR worth
        PqcKey memory rotated = pqcKeygen(keccak256("rotated"));
        pqcRegister(agentVoucher, rotated.publicKey, true); // payer side rotates the key...
        vm.prank(owner);
        escrow.startExit(id); // ...and tries to exit with a full refund
        escrow.claim(id, 0.4 ether, agentKey.publicKey, earned); // the provider still gets paid
        assertEq(provider.balance, 0.4 ether);
    }

    /// Review finding TG-1: deregistering the voucher account (or losing possessionProven) must not strand vouchers.
    function test_deregistrationCannotStrandEarnedVouchers() public {
        uint256 id = _open(1 ether);
        bytes memory earned = _voucher(agentKey, id, 0.3 ether);
        pqcRegister(agentVoucher, agentKey.publicKey, false);
        escrow.claim(id, 0.3 ether, agentKey.publicKey, earned);
        assertEq(provider.balance, 0.3 ether);
    }

    function test_vouchersByARotatedKeyAreRejected() public {
        uint256 id = _open(1 ether);
        PqcKey memory rotated = pqcKeygen(keccak256("rotated"));
        pqcRegister(agentVoucher, rotated.publicKey, true);
        bytes memory v = _voucher(rotated, id, 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.WrongVoucherKey.selector, id));
        escrow.claim(id, 0.1 ether, rotated.publicKey, v);
    }

    function test_failsClosedWithoutPrecompiles() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.1 ether);
        deactivatePqc();
        vm.expectRevert();
        escrow.claim(id, 0.1 ether, agentKey.publicKey, v);
        assertEq(provider.balance, 0);
    }

    // ------------------------------------------------------------------ exit and close

    function test_exitLetsProviderClaimThenRefundsRest() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.4 ether);
        vm.prank(owner);
        escrow.startExit(id);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ChallengePeriodActive.selector, uint64(block.timestamp + CHALLENGE)));
        escrow.finalizeExit(id);
        escrow.claim(id, 0.4 ether, agentKey.publicKey, v);
        vm.warp(block.timestamp + CHALLENGE);
        uint256 before = owner.balance;
        escrow.finalizeExit(id);
        assertEq(provider.balance, 0.4 ether);
        assertEq(owner.balance - before, 0.6 ether);
        assertTrue(escrow.channel(id).closed);
    }

    function test_claimAtExactExitAtStillWorks() public {
        uint256 id = _open(1 ether);
        vm.prank(owner);
        escrow.startExit(id);
        vm.warp(block.timestamp + CHALLENGE); // == exitAt: both claim and finalize are valid; ties favour the provider
        _claim(id, 0.2 ether);
        assertEq(provider.balance, 0.2 ether);
    }

    function test_silentProviderGetsNothingAfterExit() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.4 ether);
        vm.prank(owner);
        escrow.startExit(id);
        vm.warp(block.timestamp + CHALLENGE);
        escrow.finalizeExit(id);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ChannelClosed.selector, id));
        escrow.claim(id, 0.4 ether, agentKey.publicKey, v);
    }

    function test_onlyPayerStartsExit() public {
        uint256 id = _open(1 ether);
        vm.prank(provider);
        vm.expectRevert(ChannelEscrow.NotPayer.selector);
        escrow.startExit(id);
    }

    function test_startExitTwiceReverts() public {
        uint256 id = _open(1 ether);
        vm.startPrank(owner);
        escrow.startExit(id);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ExitPending.selector, id));
        escrow.startExit(id);
        vm.stopPrank();
    }

    function test_finalizeWithoutExitReverts() public {
        uint256 id = _open(1 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.NoExitPending.selector, id));
        escrow.finalizeExit(id);
    }

    function test_providerCanCloseEarly() public {
        uint256 id = _open(1 ether);
        _claim(id, 0.2 ether);
        uint256 before = owner.balance;
        vm.prank(provider);
        escrow.closeByProvider(id);
        assertEq(owner.balance - before, 0.8 ether);
    }

    function test_onlyProviderCloses() public {
        uint256 id = _open(1 ether);
        vm.prank(attacker);
        vm.expectRevert(ChannelEscrow.NotProvider.selector);
        escrow.closeByProvider(id);
    }

    function test_revertingPayerOnlyBlocksItsOwnRefund() public {
        RevertingPayer payer = new RevertingPayer();
        pqcRegisterNew(address(payer), keccak256("payer")); // not used; payer approves via owner flow below
        // approve the provider for the contract payer through its own ML-DSA key
        PqcKey memory payerKey = pqcRegisterNew(address(payer), keccak256("payer-key"));
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = pqcSignMessage(payerKey, escrow.providerText(address(payer), provider, agentVoucher, 0, deadline));
        escrow.setProvider(address(payer), provider, agentVoucher, 0, deadline, sig);
        uint256 id = payer.open{value: 1 ether}(escrow, provider);
        _claim(id, 0.3 ether); // provider still gets paid
        payer.startExit(escrow, id);
        vm.warp(block.timestamp + CHALLENGE);
        vm.expectRevert(ChannelEscrow.TransferFailed.selector);
        escrow.finalizeExit(id);
        assertEq(provider.balance, 0.3 ether);
    }

    function test_topUp() public {
        uint256 id = _open(1 ether);
        vm.prank(owner);
        escrow.topUp{value: 0.5 ether}(id);
        assertEq(escrow.channel(id).deposit, 1.5 ether);
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        vm.expectRevert(ChannelEscrow.NotPayer.selector);
        escrow.topUp{value: 1 ether}(id);
    }

    function test_topUpRevertsDuringExitAndWhenZero() public {
        uint256 id = _open(1 ether);
        vm.startPrank(owner);
        vm.expectRevert(ChannelEscrow.ZeroDeposit.selector);
        escrow.topUp(id);
        escrow.startExit(id);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ExitPending.selector, id));
        escrow.topUp{value: 1 ether}(id);
        vm.stopPrank();
    }

    function test_unknownChannelReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.UnknownChannel.selector, 7));
        escrow.channel(7);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.UnknownChannel.selector, 7));
        escrow.voucherText(7, 1);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.UnknownChannel.selector, 7));
        escrow.startExit(7);
    }

    /// Review finding TG-10: the challenge period is bounded (no uint64 truncation, no zero-length challenge).
    function test_challengePeriodIsBounded() public {
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.BadChallengePeriod.selector, 0));
        new ChannelEscrow(0);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.BadChallengePeriod.selector, type(uint64).max));
        new ChannelEscrow(type(uint64).max);
    }

    // ------------------------------------------------------------------ conservation (fuzz, real ML-DSA)

    /// forge-config: default.fuzz.runs = 24
    function testFuzz_fundsAreConserved(uint96 deposit, uint96 c1, uint96 c2) public {
        deposit = uint96(bound(deposit, 1, 50 ether));
        c1 = uint96(bound(c1, 1, deposit));
        c2 = uint96(bound(c2, c1, 2 * uint256(deposit)));
        uint256 id = _open(deposit);
        _claim(id, c1);
        if (c2 > c1 && c1 < deposit) _claim(id, c2);
        vm.prank(owner);
        escrow.startExit(id);
        vm.warp(block.timestamp + CHALLENGE);
        uint256 before = owner.balance;
        escrow.finalizeExit(id);
        assertEq(provider.balance + (owner.balance - before), deposit, "paid + refunded == deposit");
        assertEq(address(escrow).balance, 0);
    }
}
