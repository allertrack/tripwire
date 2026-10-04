// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireGuard} from "../src/TripwireGuard.sol";
import {CREReceiver} from "../src/cre/CREReceiver.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {ITripwireGuard} from "../src/interfaces/ITripwireGuard.sol";
import {Actions, Level, Reasons} from "../src/libraries/TripwireTypes.sol";
import {GuardFixture} from "./helpers/GuardFixture.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract TripwireGuardTest is GuardFixture {
  uint8 internal constant NORMAL = uint8(Level.Normal);
  uint8 internal constant CAUTION = uint8(Level.Caution);
  uint8 internal constant RESTRICTED = uint8(Level.Restricted);
  uint8 internal constant FROZEN = uint8(Level.Frozen);

  function setUp() public {
    guard = _deployGuard();
  }

  // ─── Deployment ──────────────────────────────────────────────────────────

  function test_deploy_startsNormalWithDefaults() public view {
    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), NORMAL);
    assertEq(uint8(s.effectiveLevel), NORMAL);
    assertFalse(s.stale);
    assertEq(s.reasons, 0);
    assertEq(s.heartbeat, HEARTBEAT);
    assertEq(uint8(s.staleLevel), CAUTION);
    assertEq(s.lastObservedAt, block.timestamp);
    assertEq(s.permissions, guard.DEFAULT_PERMISSIONS());
    assertEq(guard.owner(), governance);
    assertEq(guard.i_chainSelector(), CHAIN_SELECTOR);
    assertTrue(guard.isGuardian(guardian));
  }

  function test_deploy_defaultPermissionLadder() public view {
    assertEq(guard.permissionsAt(Level.Normal), Actions.ALL);
    assertEq(guard.permissionsAt(Level.Caution) & (Actions.BORROW | Actions.MINT), 0);
    assertEq(
      guard.permissionsAt(Level.Caution) & (Actions.WITHDRAW | Actions.LIQUIDATE), Actions.WITHDRAW | Actions.LIQUIDATE
    );
    assertEq(guard.permissionsAt(Level.Restricted) & (Actions.LIQUIDATE | Actions.BRIDGE_OUT), 0);
    assertEq(guard.permissionsAt(Level.Restricted) & Actions.WITHDRAW, Actions.WITHDRAW);
    assertEq(guard.permissionsAt(Level.Frozen), 0);
  }

  function test_deploy_revertsOnBadBounds() public {
    TripwireGuard.InitParams memory p = _params();
    p.heartbeat = 59;
    vm.expectRevert(TripwireGuard.OutOfBounds.selector);
    new TripwireGuard(p);

    p = _params();
    p.relaxDelay = 59;
    vm.expectRevert(TripwireGuard.OutOfBounds.selector);
    new TripwireGuard(p);

    p = _params();
    p.maxReportAge = 59;
    vm.expectRevert(TripwireGuard.OutOfBounds.selector);
    new TripwireGuard(p);

    p = _params();
    p.maxReportAge = 1 hours + 1;
    vm.expectRevert(TripwireGuard.OutOfBounds.selector);
    new TripwireGuard(p);
  }

  function test_deploy_revertsWithoutWorkflowIdentity() public {
    TripwireGuard.InitParams memory p = _params();
    p.identity.workflowOwner = address(0);
    vm.expectRevert(CREReceiver.WorkflowIdentityNotConfigured.selector);
    new TripwireGuard(p);

    p.identity.forwarder = address(0);
    vm.expectRevert(CREReceiver.ZeroAddress.selector);
    new TripwireGuard(p);
  }

  function test_deploy_revertsOnNonMonotonePermissions() public {
    TripwireGuard.InitParams memory p = _params();
    p.permissions = uint64(Actions.BORROW) << 16; // Caution allows borrow, Normal allows nothing
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NonMonotonePermissions.selector, p.permissions));
    new TripwireGuard(p);
  }

  function test_supportsInterface() public view {
    assertTrue(guard.supportsInterface(type(IReceiver).interfaceId));
    assertTrue(guard.supportsInterface(type(IERC165).interfaceId));
    assertTrue(guard.supportsInterface(type(ITripwireGuard).interfaceId));
    assertFalse(guard.supportsInterface(0xdeadbeef));
  }

  // ─── Report authentication and binding ───────────────────────────────────

  function test_report_rejectsNonForwarder() public {
    bytes memory report = _report(address(guard), uint40(block.timestamp), FROZEN, 0);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidForwarder.selector, address(this)));
    guard.onReport(_metadata(), report);
  }

  function test_report_rejectsWrongWorkflowOwner() public {
    address impostor = makeAddr("impostor");
    bytes memory metadata = abi.encodePacked(workflowId, workflowName, impostor);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidWorkflowOwner.selector, impostor));
    guard.onReport(metadata, _report(address(guard), uint40(block.timestamp), FROZEN, 0));
  }

  function test_report_rejectsWrongWorkflowName() public {
    bytes10 other = bytes10("othername0");
    bytes memory metadata = abi.encodePacked(workflowId, other, workflowOwner);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidWorkflowName.selector, other));
    guard.onReport(metadata, _report(address(guard), uint40(block.timestamp), FROZEN, 0));
  }

  function test_report_rejectsWrongWorkflowIdWhenPinned() public {
    CREReceiver.WorkflowIdentity memory id = guard.getWorkflowIdentity();
    id.workflowId = keccak256("pinned-build");
    vm.prank(governance);
    guard.setWorkflowIdentity(id);

    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidWorkflowId.selector, workflowId));
    guard.onReport(_metadata(), _report(address(guard), uint40(block.timestamp), FROZEN, 0));
  }

  function test_report_rejectsShortMetadata() public {
    vm.prank(forwarder);
    vm.expectRevert(CREReceiver.InvalidMetadata.selector);
    guard.onReport(hex"00", _report(address(guard), uint40(block.timestamp), FROZEN, 0));
  }

  function test_report_simulationModeTrustsForwarderOnly() public {
    CREReceiver.WorkflowIdentity memory id = guard.getWorkflowIdentity();
    id.trustForwarderOnly = true;
    vm.prank(governance);
    guard.setWorkflowIdentity(id);

    vm.warp(block.timestamp + 30);
    vm.prank(forwarder);
    guard.onReport("", _report(address(guard), uint40(block.timestamp), CAUTION, 0));
    assertEq(uint8(guard.status().level), CAUTION);
  }

  function test_report_rejectsOtherChain() public {
    bytes memory report =
      abi.encode(uint64(1), address(guard), uint40(block.timestamp), FROZEN, uint32(0), bytes32(0), 0);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.WrongChain.selector, uint64(1)));
    guard.onReport(_metadata(), report);
  }

  /// @dev A DON-signed report for one guard must not be replayable into another guard on the same chain.
  function test_report_rejectsOtherTarget() public {
    TripwireGuard other = new TripwireGuard(_params());
    bytes memory report = _report(address(other), uint40(block.timestamp), FROZEN, 0);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.WrongTarget.selector, address(other)));
    guard.onReport(_metadata(), report);
  }

  function test_report_rejectsInvalidLevel() public {
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.InvalidLevel.selector, uint8(4)));
    guard.onReport(_metadata(), _report(address(guard), uint40(block.timestamp), 4, 0));
  }

  function test_report_rejectsOutOfOrder() public {
    vm.warp(block.timestamp + 30);
    _deliver(NORMAL, 0);
    uint40 last = uint40(block.timestamp);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.OutOfOrderReport.selector, last, last));
    guard.onReport(_metadata(), _report(address(guard), last, FROZEN, 0));
  }

  function test_report_rejectsFromFuture() public {
    uint40 future = uint40(block.timestamp + guard.MAX_CLOCK_SKEW() + 1);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.ReportFromFuture.selector, future));
    guard.onReport(_metadata(), _report(address(guard), future, FROZEN, 0));
  }

  function test_report_rejectsTooOld() public {
    vm.warp(block.timestamp + MAX_REPORT_AGE + 10);
    uint40 old = uint40(block.timestamp - MAX_REPORT_AGE - 1);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.ReportTooOld.selector, old));
    guard.onReport(_metadata(), _report(address(guard), old, FROZEN, 0));
  }

  // ─── Tighten-only automation ─────────────────────────────────────────────

  function test_report_tightens() public {
    vm.warp(block.timestamp + 30);
    vm.expectEmit(address(guard));
    emit TripwireGuard.Tripped(
      Level.Normal, Level.Restricted, Reasons.ORACLE_DEVIATION, keccak256("evidence"), forwarder
    );
    vm.expectEmit(address(guard));
    emit TripwireGuard.Observed(
      uint40(block.timestamp), Level.Restricted, Reasons.ORACLE_DEVIATION, keccak256("evidence"), 42
    );
    _deliver(RESTRICTED, Reasons.ORACLE_DEVIATION);

    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), RESTRICTED);
    assertEq(s.reasons, Reasons.ORACLE_DEVIATION);
    assertEq(s.epoch, 1);
    assertEq(s.trippedAt, block.timestamp);
    assertFalse(guard.isBorrowAllowed());
    assertFalse(guard.isLiquidationAllowed());
    assertTrue(guard.isAllowed(Actions.WITHDRAW));
  }

  function test_report_neverLoosens() public {
    vm.warp(block.timestamp + 30);
    _deliver(FROZEN, Reasons.OUTFLOW_VELOCITY);
    vm.warp(block.timestamp + 30);
    _deliver(NORMAL, 0);

    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), FROZEN);
    assertEq(uint8(s.lastReportedLevel), NORMAL);
    assertEq(s.reasons, Reasons.OUTFLOW_VELOCITY);
    assertEq(s.epoch, 1);
  }

  function test_report_accumulatesReasonsAtSameLevel() public {
    vm.warp(block.timestamp + 30);
    _deliver(CAUTION, Reasons.UTILIZATION);
    vm.warp(block.timestamp + 30);
    _deliver(CAUTION, Reasons.REFERENCE_DIVERGENCE);
    assertEq(guard.status().reasons, Reasons.UTILIZATION | Reasons.REFERENCE_DIVERGENCE);
    assertEq(guard.status().epoch, 1);
  }

  function test_report_heartbeatKeepsNormal() public {
    vm.warp(block.timestamp + 30);
    _deliver(NORMAL, 0);
    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), NORMAL);
    assertEq(s.lastObservedAt, block.timestamp);
    assertEq(s.epoch, 0);
    assertTrue(guard.isBorrowAllowed());
  }

  // ─── Liveness ────────────────────────────────────────────────────────────

  function test_liveness_failsSafeWhenWatcherGoesQuiet() public {
    vm.warp(block.timestamp + HEARTBEAT + 1);
    ITripwireGuard.Status memory s = guard.status();
    assertTrue(s.stale);
    assertEq(uint8(s.level), NORMAL);
    assertEq(uint8(s.effectiveLevel), CAUTION);
    assertEq(s.reasons, Reasons.LIVENESS);
    assertFalse(guard.isBorrowAllowed());
    assertTrue(guard.isLiquidationAllowed());

    _deliver(NORMAL, 0);
    assertFalse(guard.status().stale);
    assertTrue(guard.isBorrowAllowed());
  }

  function test_liveness_doesNotLowerAHigherLevel() public {
    vm.warp(block.timestamp + 30);
    _deliver(FROZEN, Reasons.ORACLE_STALE);
    vm.warp(block.timestamp + HEARTBEAT + 1);
    assertEq(uint8(guard.effectiveLevel()), FROZEN);
  }

  function test_liveness_exactlyAtHeartbeatIsFresh() public {
    vm.warp(block.timestamp + HEARTBEAT);
    assertFalse(guard.status().stale);
  }

  // ─── Guardians ───────────────────────────────────────────────────────────

  function test_trip_byGuardian() public {
    vm.expectEmit(address(guard));
    emit TripwireGuard.Tripped(Level.Normal, Level.Frozen, Reasons.MANUAL | 7, bytes32(0), guardian);
    vm.prank(guardian);
    guard.trip(Level.Frozen, 7);
    assertEq(uint8(guard.status().level), FROZEN);
    assertEq(guard.status().reasons, Reasons.MANUAL | 7);
    assertFalse(guard.isAllowed(Actions.WITHDRAW));
  }

  function test_trip_byOwner() public {
    vm.prank(governance);
    guard.trip(Level.Caution, 0);
    assertEq(uint8(guard.status().level), CAUTION);
  }

  function test_trip_revertsForStrangers() public {
    address stranger = makeAddr("stranger");
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NotGuardian.selector, stranger));
    guard.trip(Level.Frozen, 0);
  }

  function test_trip_cannotLoosen() public {
    vm.prank(guardian);
    guard.trip(Level.Restricted, 0);
    vm.prank(guardian);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NotTighter.selector, Level.Restricted, Level.Caution));
    guard.trip(Level.Caution, 0);
  }

  function test_guardian_canBeRevoked() public {
    vm.prank(governance);
    guard.setGuardian(guardian, false);
    vm.prank(guardian);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NotGuardian.selector, guardian));
    guard.trip(Level.Frozen, 0);
  }

  // ─── Relax ───────────────────────────────────────────────────────────────

  function _tripAndPropose(
    Level target
  ) internal {
    vm.warp(block.timestamp + 30);
    _deliver(FROZEN, Reasons.ORACLE_DEVIATION);
    vm.prank(governance);
    guard.proposeRelax(target);
  }

  function test_relax_happyPath() public {
    _tripAndPropose(Level.Normal);
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(NORMAL, 0); // the watcher agrees

    vm.expectEmit(address(guard));
    emit TripwireGuard.Relaxed(Level.Frozen, Level.Normal);
    vm.prank(makeAddr("anyone")); // permissionless once matured
    guard.executeRelax();

    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), NORMAL);
    assertEq(s.reasons, 0);
    assertEq(s.epoch, 2);
    assertFalse(s.relaxPending);
    assertTrue(guard.isBorrowAllowed());
  }

  function test_relax_partialKeepsCurrentReasons() public {
    _tripAndPropose(Level.Caution);
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(CAUTION, Reasons.UTILIZATION);
    guard.executeRelax();
    assertEq(uint8(guard.status().level), CAUTION);
    assertEq(guard.status().reasons, Reasons.UTILIZATION);
  }

  function test_relax_onlyOwnerProposes() public {
    vm.prank(guardian);
    guard.trip(Level.Frozen, 0);
    vm.prank(guardian);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    guard.proposeRelax(Level.Normal);
  }

  function test_relax_mustLoosen() public {
    vm.prank(governance);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NotLooser.selector, Level.Normal, Level.Normal));
    guard.proposeRelax(Level.Normal);
  }

  function test_relax_revertsWithoutProposal() public {
    vm.expectRevert(TripwireGuard.NoPendingRelax.selector);
    guard.executeRelax();
  }

  function test_relax_revertsBeforeDelay() public {
    _tripAndPropose(Level.Normal);
    uint40 readyAt = guard.status().relaxReadyAt;
    vm.warp(block.timestamp + RELAX_DELAY - 1);
    _deliver(NORMAL, 0);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.RelaxNotReady.selector, readyAt));
    guard.executeRelax();
  }

  function test_relax_supersededByNewTrip() public {
    vm.warp(block.timestamp + 30);
    _deliver(RESTRICTED, Reasons.UTILIZATION);
    vm.prank(governance);
    guard.proposeRelax(Level.Normal);
    vm.warp(block.timestamp + 30);
    _deliver(FROZEN, Reasons.OUTFLOW_VELOCITY); // new trip after the proposal
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(NORMAL, 0);
    vm.expectRevert(TripwireGuard.RelaxSuperseded.selector);
    guard.executeRelax();
  }

  function test_relax_revertsWhenWatcherStale() public {
    _tripAndPropose(Level.Normal);
    vm.warp(block.timestamp + 30);
    _deliver(NORMAL, 0);
    vm.warp(block.timestamp + RELAX_DELAY + HEARTBEAT);
    vm.expectRevert(TripwireGuard.WatcherStale.selector);
    guard.executeRelax();
  }

  function test_relax_needsEvidenceAfterProposal() public {
    vm.prank(governance);
    guard.setRelaxDelay(60); // shorter than the heartbeat, so only the evidence check can fail
    vm.warp(block.timestamp + 30);
    _deliver(FROZEN, Reasons.ORACLE_DEVIATION);
    vm.warp(block.timestamp + 1);
    _deliver(NORMAL, 0); // observed before the proposal
    vm.prank(governance);
    guard.proposeRelax(Level.Normal);
    vm.warp(block.timestamp + 60);
    vm.expectRevert(TripwireGuard.NoFreshEvidence.selector);
    guard.executeRelax();
  }

  function test_relax_revertsWhenWatcherDisagrees() public {
    _tripAndPropose(Level.Normal);
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(CAUTION, Reasons.UTILIZATION);
    vm.expectRevert(abi.encodeWithSelector(TripwireGuard.WatcherDisagrees.selector, Level.Caution, Level.Normal));
    guard.executeRelax();
  }

  function test_relax_cancelledByGuardian() public {
    _tripAndPropose(Level.Normal);
    vm.expectEmit(address(guard));
    emit TripwireGuard.RelaxCancelled(guardian);
    vm.prank(guardian);
    guard.cancelRelax();
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(NORMAL, 0);
    vm.expectRevert(TripwireGuard.NoPendingRelax.selector);
    guard.executeRelax();
  }

  function test_relax_cannotBeExecutedTwice() public {
    _tripAndPropose(Level.Normal);
    vm.warp(block.timestamp + RELAX_DELAY);
    _deliver(NORMAL, 0);
    guard.executeRelax();
    vm.expectRevert(TripwireGuard.NoPendingRelax.selector);
    guard.executeRelax();
  }

  // ─── Governance configuration ────────────────────────────────────────────

  function test_config_onlyOwner() public {
    vm.startPrank(guardian);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    guard.setPermissions(0);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    guard.setLiveness(HEARTBEAT, Level.Frozen);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    guard.setRelaxDelay(RELAX_DELAY);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    guard.setGuardian(guardian, true);
    vm.stopPrank();
  }

  function test_config_customPermissions() public {
    uint64 perms = uint64(Actions.ALL) | (uint64(Actions.WITHDRAW) << 16) | (uint64(Actions.WITHDRAW) << 32);
    vm.prank(governance);
    guard.setPermissions(perms);
    vm.prank(guardian);
    guard.trip(Level.Restricted, 0);
    assertTrue(guard.isAllowed(Actions.WITHDRAW));
    assertFalse(guard.isAllowed(Actions.WITHDRAW | Actions.SWAP));
  }

  function test_config_liveness() public {
    vm.prank(governance);
    guard.setLiveness(1 hours, Level.Frozen);
    vm.warp(block.timestamp + 1 hours + 1);
    assertEq(uint8(guard.effectiveLevel()), FROZEN);
  }

  function test_ownership_twoStep() public {
    address next = makeAddr("next");
    vm.prank(governance);
    guard.transferOwnership(next);
    assertEq(guard.owner(), governance);
    vm.prank(next);
    guard.acceptOwnership();
    assertEq(guard.owner(), next);
  }

  // ─── Fuzz ────────────────────────────────────────────────────────────────

  /// @dev Whatever the watcher reports, the stored level is the running maximum.
  function testFuzz_levelIsRunningMax(
    uint8[8] memory levels
  ) public {
    uint8 expected;
    for (uint256 i; i < levels.length; ++i) {
      uint8 level = levels[i] % 4;
      vm.warp(block.timestamp + 30);
      _deliver(level, 1);
      if (level > expected) expected = level;
      assertEq(uint8(guard.status().level), expected);
    }
  }

  /// @dev isAllowed matches a reference model of (level, staleness, permissions).
  function testFuzz_isAllowedMatchesModel(
    uint8 level,
    uint16 actions,
    uint32 elapsed,
    bool customPerms
  ) public {
    level = level % 4;
    elapsed = uint32(bound(elapsed, 0, 3 * HEARTBEAT));
    if (customPerms) {
      vm.prank(governance);
      guard.setPermissions(0x0000_0003_0007_ffff);
    }
    if (level > 0) {
      vm.prank(guardian);
      guard.trip(Level(level), 0);
    }
    vm.warp(block.timestamp + elapsed);

    uint8 effective = level;
    if (elapsed > HEARTBEAT && effective < CAUTION) effective = CAUTION;
    uint64 perms = customPerms ? 0x0000_0003_0007_ffff : guard.DEFAULT_PERMISSIONS();
    uint16 allowed = uint16(perms >> (16 * effective));
    assertEq(guard.isAllowed(actions), allowed & actions == actions);
    assertEq(uint8(guard.effectiveLevel()), effective);
  }

  function testFuzz_rejectsAnySender(
    address sender
  ) public {
    vm.assume(sender != forwarder);
    vm.prank(sender);
    vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidForwarder.selector, sender));
    guard.onReport(_metadata(), _report(address(guard), uint40(block.timestamp), FROZEN, 0));
  }

  function testFuzz_setPermissionsAcceptsOnlyMonotone(
    uint64 perms
  ) public {
    bool monotone = true;
    for (uint256 l = 1; l < 4; ++l) {
      if (uint16(perms >> (16 * l)) & ~uint16(perms >> (16 * (l - 1))) != 0) monotone = false;
    }
    vm.prank(governance);
    if (!monotone) vm.expectRevert(abi.encodeWithSelector(TripwireGuard.NonMonotonePermissions.selector, perms));
    guard.setPermissions(perms);
  }

  // ─── Gas ─────────────────────────────────────────────────────────────────

  function test_gas_hotPaths() public {
    vm.warp(block.timestamp + 30);
    vm.prank(forwarder);
    guard.onReport(_metadata(), _report(address(guard), uint40(block.timestamp), NORMAL, 0));
    vm.snapshotGasLastFrame("onReport: heartbeat");

    vm.warp(block.timestamp + 30);
    vm.prank(forwarder);
    guard.onReport(_metadata(), _report(address(guard), uint40(block.timestamp), FROZEN, Reasons.ORACLE_DEVIATION));
    vm.snapshotGasLastFrame("onReport: trip");

    guard.isAllowed(Actions.BORROW);
    vm.snapshotGasLastFrame("isAllowed");
    guard.isBorrowAllowed();
    vm.snapshotGasLastFrame("isBorrowAllowed (Aave sentinel)");
  }
}
