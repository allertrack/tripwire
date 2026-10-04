// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireGuard} from "../src/TripwireGuard.sol";
import {ITripwireGuard} from "../src/interfaces/ITripwireGuard.sol";
import {Level, Reasons} from "../src/libraries/TripwireTypes.sol";
import {GuardFixture} from "./helpers/GuardFixture.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives a guard through random interleavings of reports, guardian trips, relax proposals, executions,
/// cancellations, configuration changes and time, and records every level change by the action that caused it.
contract GuardHandler is CommonBase, StdCheats, StdUtils {
  TripwireGuard internal immutable guard;
  address internal immutable forwarder;
  address internal immutable governance;
  address internal immutable guardian;
  bytes internal metadata;
  uint64 internal immutable chainSelector;

  // Ghosts
  bool public loosenedOutsideRelax;
  bool public relaxWithoutConsent;
  bool public observedAtWentBack;
  uint256 public relaxes;
  uint256 public trips;

  constructor(
    TripwireGuard guard_,
    address forwarder_,
    address governance_,
    address guardian_,
    bytes memory metadata_,
    uint64 chainSelector_
  ) {
    guard = guard_;
    forwarder = forwarder_;
    governance = governance_;
    guardian = guardian_;
    metadata = metadata_;
    chainSelector = chainSelector_;
  }

  function report(
    uint8 level,
    uint32 reasons,
    uint16 lateBy
  ) external {
    level = level % 4;
    ITripwireGuard.Status memory before = guard.status();
    uint40 observedAt = uint40(block.timestamp - bound(lateBy, 0, 400)); // sometimes too old / out of order
    bytes memory payload =
      abi.encode(chainSelector, address(guard), observedAt, level, reasons & 0xffff, bytes32(0), uint256(0));
    vm.prank(forwarder);
    try guard.onReport(metadata, payload) {
      if (level > uint8(before.level)) ++trips;
    } catch {}
    _checkNoLoosening(before);
  }

  function trip(
    uint8 level,
    uint32 reasons
  ) external {
    ITripwireGuard.Status memory before = guard.status();
    vm.prank(guardian);
    try guard.trip(Level(level % 4), reasons) {
      ++trips;
    } catch {}
    _checkNoLoosening(before);
  }

  function propose(
    uint8 level
  ) external {
    ITripwireGuard.Status memory before = guard.status();
    vm.prank(governance);
    try guard.proposeRelax(Level(level % 4)) {} catch {}
    _checkNoLoosening(before);
  }

  function cancel() external {
    ITripwireGuard.Status memory before = guard.status();
    vm.prank(guardian);
    try guard.cancelRelax() {} catch {}
    _checkNoLoosening(before);
  }

  function execute() external {
    ITripwireGuard.Status memory before = guard.status();
    try guard.executeRelax() {
      ++relaxes;
      ITripwireGuard.Status memory afterwards = guard.status();
      // Two-key property: matured proposal from this epoch, fresh watcher that agrees with the new level.
      if (
        !before.relaxPending || block.timestamp < before.relaxReadyAt || before.stale
          || uint8(before.lastReportedLevel) > uint8(afterwards.level) || afterwards.epoch != before.epoch + 1
      ) relaxWithoutConsent = true;
    } catch {}
  }

  function setLiveness(
    uint32 heartbeat,
    uint8 staleLevel
  ) external {
    ITripwireGuard.Status memory before = guard.status();
    vm.prank(governance);
    try guard.setLiveness(uint32(bound(heartbeat, 60, 2 hours)), Level(staleLevel % 4)) {} catch {}
    _checkNoLoosening(before);
  }

  function warp(
    uint32 dt
  ) external {
    ITripwireGuard.Status memory before = guard.status();
    vm.warp(block.timestamp + bound(dt, 1, 2 hours));
    _checkNoLoosening(before);
  }

  function _checkNoLoosening(
    ITripwireGuard.Status memory before
  ) internal {
    ITripwireGuard.Status memory afterwards = guard.status();
    if (uint8(afterwards.level) < uint8(before.level)) loosenedOutsideRelax = true;
    if (afterwards.lastObservedAt < before.lastObservedAt) observedAtWentBack = true;
  }
}

contract TripwireGuardInvariantTest is GuardFixture {
  GuardHandler internal handler;

  function setUp() public {
    guard = _deployGuard();
    handler = new GuardHandler(guard, forwarder, governance, guardian, _metadata(), CHAIN_SELECTOR);
    targetContract(address(handler));
  }

  /// @dev 1. Only executeRelax can lower the stored level.
  function invariant_tightenOnlyOutsideRelax() public view {
    assertFalse(handler.loosenedOutsideRelax());
  }

  /// @dev 2. Every successful relax had governance's matured proposal and the fresh watcher's agreement.
  function invariant_relaxNeedsBothKeys() public view {
    assertFalse(handler.relaxWithoutConsent());
  }

  /// @dev 3. The effective level is never below the stored level, and never below staleLevel while stale.
  function invariant_failSafeLiveness() public view {
    ITripwireGuard.Status memory s = guard.status();
    assertGe(uint8(s.effectiveLevel), uint8(s.level));
    if (s.stale) {
      assertGe(uint8(s.effectiveLevel), uint8(s.staleLevel));
      assertTrue(s.reasons & Reasons.LIVENESS != 0);
    }
    assertEq(s.stale, block.timestamp > uint256(s.lastObservedAt) + s.heartbeat);
  }

  /// @dev 4. Allow-lists stay monotone, so a stricter level never allows more.
  function invariant_permissionsMonotone() public view {
    for (uint8 l = 1; l < 4; ++l) {
      uint16 lower = guard.permissionsAt(Level(l - 1));
      uint16 upper = guard.permissionsAt(Level(l));
      assertEq(upper & ~lower, 0);
    }
  }

  /// @dev 5. Report timestamps never go backwards.
  function invariant_observationsInOrder() public view {
    assertFalse(handler.observedAtWentBack());
  }
}
