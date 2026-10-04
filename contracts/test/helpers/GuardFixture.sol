// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireGuard} from "../../src/TripwireGuard.sol";
import {CREReceiver} from "../../src/cre/CREReceiver.sol";
import {Level} from "../../src/libraries/TripwireTypes.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Deploys a guard behind a stand-in Forwarder and builds CRE reports the way the workflow does.
abstract contract GuardFixture is Test {
  uint64 internal constant CHAIN_SELECTOR = 2183018362218727504; // monad-testnet
  uint32 internal constant HEARTBEAT = 10 minutes;
  uint32 internal constant RELAX_DELAY = 1 hours;
  uint32 internal constant MAX_REPORT_AGE = 5 minutes;

  address internal forwarder = makeAddr("forwarder");
  address internal governance = makeAddr("governance");
  address internal guardian = makeAddr("guardian");
  address internal workflowOwner = makeAddr("workflowOwner");
  bytes32 internal workflowId = keccak256("tripwire-workflow");
  bytes10 internal workflowName = bytes10("tripwire00");

  TripwireGuard internal guard;

  function _deployGuard() internal returns (TripwireGuard g) {
    if (block.timestamp < 1_790_000_000) vm.warp(1_790_000_000); // never move a live fork back in time
    g = new TripwireGuard(_params());
    vm.prank(governance);
    g.setGuardian(guardian, true);
  }

  function _params() internal view returns (TripwireGuard.InitParams memory) {
    return TripwireGuard.InitParams({
      chainSelector: CHAIN_SELECTOR,
      owner: governance,
      identity: CREReceiver.WorkflowIdentity({
        forwarder: forwarder,
        workflowId: bytes32(0),
        workflowOwner: workflowOwner,
        workflowName: workflowName,
        trustForwarderOnly: false
      }),
      heartbeat: HEARTBEAT,
      staleLevel: Level.Caution,
      relaxDelay: RELAX_DELAY,
      maxReportAge: MAX_REPORT_AGE,
      permissions: 0
    });
  }

  function _metadata() internal view returns (bytes memory) {
    return abi.encodePacked(workflowId, workflowName, workflowOwner, bytes2(0x0001));
  }

  function _report(
    address target,
    uint40 observedAt,
    uint8 level,
    uint32 reasons
  ) internal pure returns (bytes memory) {
    return abi.encode(CHAIN_SELECTOR, target, observedAt, level, reasons, keccak256("evidence"), uint256(42));
  }

  /// @dev Delivers a report observed `age` seconds ago through the Forwarder.
  function _deliver(
    uint8 level,
    uint32 reasons
  ) internal {
    _deliverAt(uint40(block.timestamp), level, reasons);
  }

  function _deliverAt(
    uint40 observedAt,
    uint8 level,
    uint32 reasons
  ) internal {
    vm.prank(forwarder);
    guard.onReport(_metadata(), _report(address(guard), observedAt, level, reasons));
  }
}
