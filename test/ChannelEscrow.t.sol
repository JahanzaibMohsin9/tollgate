// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PqcForge} from "@pqc-forge/PqcForge.sol";
import {PQSig} from "@pqc-forge/PQSig.sol";
import {ChannelEscrow} from "../src/ChannelEscrow.sol";

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

    function _allow(address p, bool allowed) internal {
        uint256 n = escrow.providerNonce(owner);
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, p, allowed, n));
        escrow.setProvider(owner, p, allowed, n, sig);
    }

    function _open(uint256 deposit) internal returns (uint256 id) {
        _allow(provider, true);
        vm.prank(owner);
        id = escrow.open{value: deposit}(provider, agentVoucher);
    }

    function _voucher(PqcKey memory k, uint256 id, uint256 cumulative) internal returns (bytes memory) {
        return pqcSignMessage(k, escrow.voucherText(id, cumulative));
    }

    // ------------------------------------------------------------------ provider allowlist

    function test_ownerAllowsProviderWithMlDsa() public {
        _allow(provider, true);
        assertTrue(escrow.providerAllowed(owner, provider));
        assertEq(escrow.providerNonce(owner), 1);
    }

    function test_agentOrAttackerCannotAllowlistAProvider() public {
        bytes memory text = escrow.providerText(owner, attacker, true, 0);
        bytes memory forged = pqcSignMessage(agentKey, text); // the agent's own ML-DSA key is not the owner's
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.setProvider(owner, attacker, true, 0, forged);
    }

    function test_allowlistSignatureCannotBeReplayed() public {
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, provider, true, 0));
        escrow.setProvider(owner, provider, true, 0, sig);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.InvalidNonce.selector, 1, 0));
        escrow.setProvider(owner, provider, true, 0, sig);
    }

    function test_ownerCanRevokeProvider() public {
        _allow(provider, true);
        _allow(provider, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ProviderNotAllowed.selector, provider));
        escrow.open{value: 1 ether}(provider, agentVoucher);
    }

    // ------------------------------------------------------------------ open

    function test_promptInjectedAgentCannotOpenToAttacker() public {
        _allow(provider, true);
        vm.prank(owner); // the agent acts as the owner's account through MsgExecuteEVM
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ProviderNotAllowed.selector, attacker));
        escrow.open{value: 1 ether}(attacker, agentVoucher);
    }

    function test_openRequiresVoucherKeyWithPossessionProof() public {
        _allow(provider, true);
        address copycat = makeAddr("copycat");
        pqcRegister(copycat, agentKey.publicKey, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQSig.PqcPossessionNotProven.selector, copycat));
        escrow.open{value: 1 ether}(provider, copycat);
    }

    function test_openRequiresDeposit() public {
        _allow(provider, true);
        vm.prank(owner);
        vm.expectRevert(ChannelEscrow.ZeroDeposit.selector);
        escrow.open(provider, agentVoucher);
    }

    // ------------------------------------------------------------------ claim

    function test_oneClaimSettlesManyCalls() public {
        uint256 id = _open(1 ether);
        // 1,000 calls at 0.0005 QOR each happen off-chain; only the latest cumulative voucher is settled.
        uint256 cumulative = 1000 * 0.0005 ether;
        bytes memory v = _voucher(agentKey, id, cumulative);
        vm.prank(provider);
        escrow.claim(id, cumulative, v);
        assertEq(provider.balance, 0.5 ether);
        assertEq(escrow.channel(id).paid, 0.5 ether);
    }

    function test_incrementalClaimsPayOnlyTheDifference() public {
        uint256 id = _open(1 ether);
        escrow.claim(id, 0.1 ether, _voucher(agentKey, id, 0.1 ether));
        escrow.claim(id, 0.25 ether, _voucher(agentKey, id, 0.25 ether));
        assertEq(provider.balance, 0.25 ether);
    }

    function test_olderVoucherCannotBeSettledAgain() public {
        uint256 id = _open(1 ether);
        bytes memory old = _voucher(agentKey, id, 0.1 ether);
        escrow.claim(id, 0.3 ether, _voucher(agentKey, id, 0.3 ether));
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.NotIncreasing.selector, 0.3 ether, 0.1 ether));
        escrow.claim(id, 0.1 ether, old);
    }

    function test_cannotClaimMoreThanDeposit() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 2 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ExceedsDeposit.selector, 1 ether, 2 ether));
        escrow.claim(id, 2 ether, v);
    }

    function test_providerCannotForgeVoucher() public {
        uint256 id = _open(1 ether);
        PqcKey memory providerKey = pqcRegisterNew(provider, keccak256("provider"));
        bytes memory forged = _voucher(providerKey, id, 1 ether);
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(id, 1 ether, forged);
    }

    function test_voucherIsBoundToItsChannel() public {
        uint256 a = _open(1 ether);
        vm.prank(owner);
        uint256 b = escrow.open{value: 1 ether}(provider, agentVoucher);
        bytes memory forA = _voucher(agentKey, a, 0.5 ether);
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(b, 0.5 ether, forA);
    }

    function test_tamperedAmountFails() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.1 ether);
        vm.expectRevert(ChannelEscrow.InvalidSignature.selector);
        escrow.claim(id, 0.9 ether, v);
    }

    function test_voucherKeyIsPinnedAtOpen() public {
        uint256 id = _open(1 ether);
        PqcKey memory rotated = pqcKeygen(keccak256("rotated"));
        pqcRegister(agentVoucher, rotated.publicKey, true); // the voucher account's key changes after open
        bytes memory v = _voucher(rotated, id, 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.VoucherKeyChanged.selector, agentVoucher));
        escrow.claim(id, 0.1 ether, v);
    }

    function test_failsClosedWithoutPrecompiles() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.1 ether);
        deactivatePqc();
        vm.expectRevert();
        escrow.claim(id, 0.1 ether, v);
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

        escrow.claim(id, 0.4 ether, v); // provider answers within the challenge period
        vm.warp(block.timestamp + CHALLENGE);
        uint256 before = owner.balance;
        escrow.finalizeExit(id);
        assertEq(provider.balance, 0.4 ether);
        assertEq(owner.balance - before, 0.6 ether);
        assertTrue(escrow.channel(id).closed);
    }

    function test_silentProviderGetsNothingAfterExit() public {
        uint256 id = _open(1 ether);
        bytes memory v = _voucher(agentKey, id, 0.4 ether);
        vm.prank(owner);
        escrow.startExit(id);
        vm.warp(block.timestamp + CHALLENGE);
        escrow.finalizeExit(id);
        vm.expectRevert(abi.encodeWithSelector(ChannelEscrow.ChannelClosed.selector, id));
        escrow.claim(id, 0.4 ether, v);
    }

    function test_onlyPayerStartsExit() public {
        uint256 id = _open(1 ether);
        vm.prank(provider);
        vm.expectRevert(ChannelEscrow.NotPayer.selector);
        escrow.startExit(id);
    }

    function test_providerCanCloseEarly() public {
        uint256 id = _open(1 ether);
        escrow.claim(id, 0.2 ether, _voucher(agentKey, id, 0.2 ether));
        uint256 before = owner.balance;
        vm.prank(provider);
        escrow.closeByProvider(id);
        assertEq(owner.balance - before, 0.8 ether);
    }

    function test_topUp() public {
        uint256 id = _open(1 ether);
        vm.prank(owner);
        escrow.topUp{value: 0.5 ether}(id);
        assertEq(escrow.channel(id).deposit, 1.5 ether);
        vm.prank(attacker);
        vm.deal(attacker, 1 ether);
        vm.expectRevert(ChannelEscrow.NotPayer.selector);
        escrow.topUp{value: 1 ether}(id);
    }

    // ------------------------------------------------------------------ conservation (fuzz, real ML-DSA)

    /// forge-config: default.fuzz.runs = 12
    function testFuzz_fundsAreConserved(uint96 deposit, uint96 c1, uint96 c2) public {
        deposit = uint96(bound(deposit, 1, 50 ether));
        c1 = uint96(bound(c1, 1, deposit));
        c2 = uint96(bound(c2, c1, deposit));
        uint256 id = _open(deposit);
        escrow.claim(id, c1, _voucher(agentKey, id, c1));
        if (c2 > c1) escrow.claim(id, c2, _voucher(agentKey, id, c2));
        vm.prank(owner);
        escrow.startExit(id);
        vm.warp(block.timestamp + CHALLENGE);
        uint256 before = owner.balance;
        escrow.finalizeExit(id);
        assertEq(provider.balance + (owner.balance - before), deposit, "paid + refunded == deposit");
        assertEq(address(escrow).balance, 0);
    }
}
