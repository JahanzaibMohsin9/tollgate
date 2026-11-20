// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PqcForge} from "@pqc-forge/PqcForge.sol";
import {ChannelEscrow} from "../src/ChannelEscrow.sol";

/// Drives one channel through random claims (real, pre-signed ML-DSA-87 vouchers), top-ups, exits, warps,
/// finalizations and provider closes.
contract EscrowHandler is Test {
    ChannelEscrow public immutable escrow;
    uint256 public immutable id;
    address public immutable payer;
    address public immutable provider;
    bytes public voucherKey;
    uint256[] public amounts; // pre-signed cumulative amounts
    bytes[] public sigs;

    uint256 public ghostPaidMax; // highest `paid` ever observed
    uint256 public ghostDeposited;
    uint256 public ghostToProvider;
    uint256 public ghostRefunded;
    bool public ghostPaidDecreased;

    constructor(ChannelEscrow e, uint256 id_, address payer_, address provider_, bytes memory key, uint256[] memory a, bytes[] memory s, uint256 deposit) {
        escrow = e;
        id = id_;
        payer = payer_;
        provider = provider_;
        voucherKey = key;
        amounts = a;
        sigs = s;
        ghostDeposited = deposit;
    }

    function _track() internal {
        uint256 paid = escrow.channel(id).paid;
        if (paid < ghostPaidMax) ghostPaidDecreased = true;
        if (paid > ghostPaidMax) ghostPaidMax = paid;
    }

    function claim(uint256 i) external {
        i = bound(i, 0, amounts.length - 1);
        uint256 before = provider.balance;
        try escrow.claim(id, amounts[i], voucherKey, sigs[i]) {
            ghostToProvider += provider.balance - before;
        } catch {}
        _track();
    }

    function topUp(uint96 v) external {
        v = uint96(bound(v, 1, 5 ether));
        vm.deal(payer, v);
        vm.prank(payer);
        try escrow.topUp{value: v}(id) {
            ghostDeposited += v;
        } catch {}
        _track();
    }

    function startExit() external {
        vm.prank(payer);
        try escrow.startExit(id) {} catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 hours));
    }

    function finalize() external {
        uint256 before = payer.balance;
        try escrow.finalizeExit(id) {
            ghostRefunded += payer.balance - before;
        } catch {}
        _track();
    }

    function providerClose() external {
        uint256 before = payer.balance;
        vm.prank(provider);
        try escrow.closeByProvider(id) {
            ghostRefunded += payer.balance - before;
        } catch {}
        _track();
    }
}

contract ChannelEscrowInvariantTest is Test, PqcForge {
    ChannelEscrow escrow;
    EscrowHandler handler;
    uint256 id;

    address owner = makeAddr("owner");
    address signer = makeAddr("voucher");
    address provider = makeAddr("provider");
    PqcKey agentKey;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(1_764_000_000);
        installPqc();
        escrow = new ChannelEscrow(1 hours);
        _approveAndOpen();
        (uint256[] memory a, bytes[] memory s) = _presign();
        handler = new EscrowHandler(escrow, id, owner, provider, agentKey.publicKey, a, s, 3 ether);
        targetContract(address(handler));
    }

    function _approveAndOpen() internal {
        PqcKey memory ownerKey = pqcRegisterNew(owner, keccak256("owner"));
        agentKey = pqcRegisterNew(signer, keccak256("agent"));
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = pqcSignMessage(ownerKey, escrow.providerText(owner, provider, signer, 0, deadline));
        escrow.setProvider(owner, provider, signer, 0, deadline, sig);
        vm.deal(owner, 3 ether);
        vm.prank(owner);
        id = escrow.open{value: 3 ether}(provider);
    }

    function _presign() internal returns (uint256[] memory a, bytes[] memory s) {
        a = new uint256[](8);
        s = new bytes[](8);
        uint256[8] memory steps = [uint256(0.1 ether), 0.4 ether, 0.9 ether, 1.5 ether, 2.2 ether, 3 ether, 4 ether, 6 ether];
        for (uint256 i; i < 8; i++) {
            a[i] = steps[i];
            s[i] = pqcSignMessage(agentKey, escrow.voucherText(id, steps[i]));
        }
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 24
    function invariant_paidNeverExceedsDeposit() public view {
        ChannelEscrow.Channel memory c = escrow.channel(id);
        assertLe(c.paid, c.deposit);
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 24
    function invariant_paidIsMonotonic() public view {
        assertFalse(handler.ghostPaidDecreased());
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 24
    function invariant_escrowHoldsExactlyWhatIsOwed() public view {
        ChannelEscrow.Channel memory c = escrow.channel(id);
        uint256 owed = c.closed ? 0 : c.deposit - c.paid;
        assertEq(address(escrow).balance, owed);
    }

    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 24
    function invariant_conservation() public view {
        assertEq(handler.ghostToProvider() + handler.ghostRefunded() + address(escrow).balance, handler.ghostDeposited());
    }
}
