// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CREReceiver} from "./cre/CREReceiver.sol";
import {ITripwireGuard} from "./interfaces/ITripwireGuard.sol";
import {Actions, Level, Reasons} from "./libraries/TripwireTypes.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title TripwireGuard
/// @notice A circuit breaker driven by a Chainlink CRE workflow. The workflow watches a market (oracle health against
/// Chainlink Data Feeds and exchange prices, utilization, outflow velocity) and sends DON-signed reports here.
///
/// Safety properties (each one is a Foundry invariant in test/TripwireGuard.invariant.t.sol):
/// 1. Tighten-only automation: a report or a guardian can raise the level, never lower it.
/// 2. Two-key relax: lowering the level takes an owner proposal, a delay, no trip in between, and a fresh watcher
///    report that agrees with the lower level.
/// 3. Fail-safe liveness: if the watcher misses its heartbeat, the effective level is at least `staleLevel`
///    without anyone sending a transaction.
/// 4. Monotone permissions: anything allowed at a level is allowed at every lower level.
/// 5. Reports are bound to this chain and this contract, and must arrive in order and on time.
///
/// Integration cost: `isAllowed` is one SLOAD (all hot state lives in a single slot).
contract TripwireGuard is ITripwireGuard, CREReceiver, Ownable2Step {
  // ─── Errors ───────────────────────────────────────────────────────────────
  error InvalidLevel(uint8 level);
  error NotTighter(Level current, Level requested);
  error NotLooser(Level current, Level requested);
  error OutOfOrderReport(uint40 observedAt, uint40 lastObservedAt);
  error ReportFromFuture(uint40 observedAt);
  error ReportTooOld(uint40 observedAt);
  error NotGuardian(address caller);
  error NoPendingRelax();
  error RelaxNotReady(uint40 readyAt);
  error RelaxSuperseded();
  error WatcherStale();
  error NoFreshEvidence();
  error WatcherDisagrees(Level reported, Level target);
  error NonMonotonePermissions(uint64 permissions);
  error OutOfBounds();

  // ─── Events ───────────────────────────────────────────────────────────────
  event Tripped(Level indexed from, Level indexed to, uint32 reasons, bytes32 evidenceHash, address indexed by);
  event Observed(uint40 observedAt, Level level, uint32 reasons, bytes32 evidenceHash, uint256 metrics);
  event RelaxProposed(Level target, uint40 readyAt, uint32 epoch);
  event RelaxCancelled(address indexed by);
  event Relaxed(Level indexed from, Level indexed to);
  event GuardianSet(address indexed guardian, bool enabled);
  event PermissionsSet(uint64 permissions);
  event LivenessSet(uint32 heartbeat, Level staleLevel);
  event RelaxDelaySet(uint32 relaxDelay);

  // ─── Bounds ───────────────────────────────────────────────────────────────
  uint8 internal constant MAX_LEVEL = uint8(Level.Frozen);
  uint32 public constant MIN_HEARTBEAT = 60;
  uint32 public constant MAX_HEARTBEAT = 7 days;
  uint32 public constant MIN_RELAX_DELAY = 60;
  uint32 public constant MAX_RELAX_DELAY = 30 days;
  uint32 public constant MAX_CLOCK_SKEW = 60;

  /// @notice Default allow-lists: Caution pauses new risk, Restricted also pauses oracle-dependent actions,
  /// Frozen pauses every gated action.
  uint16 internal constant CAUTION_ALLOWED = Actions.ALL & ~(Actions.BORROW | Actions.MINT);
  uint16 internal constant RESTRICTED_ALLOWED = CAUTION_ALLOWED & ~(Actions.LIQUIDATE | Actions.BRIDGE_OUT);
  uint64 public constant DEFAULT_PERMISSIONS =
    uint64(Actions.ALL) | (uint64(CAUTION_ALLOWED) << 16) | (uint64(RESTRICTED_ALLOWED) << 32);

  // ─── State ────────────────────────────────────────────────────────────────
  /// @dev Exactly 256 bits: everything `isAllowed` and report processing touch.
  struct Hot {
    Level level;
    Level staleLevel;
    Level lastReportedLevel;
    uint32 heartbeat;
    uint32 reasons;
    uint32 lastReportedReasons;
    uint32 epoch;
    uint40 lastObservedAt;
    uint64 permissions;
  }

  struct Cold {
    Level relaxTarget;
    uint40 relaxProposedAt;
    uint40 relaxReadyAt; // 0 = no pending proposal
    uint32 relaxEpoch;
    uint32 relaxDelay;
    uint40 trippedAt;
  }

  struct InitParams {
    uint64 chainSelector;
    address owner;
    WorkflowIdentity identity;
    uint32 heartbeat;
    Level staleLevel;
    uint32 relaxDelay;
    uint32 maxReportAge;
    uint64 permissions; // 0 = DEFAULT_PERMISSIONS
  }

  /// @notice Reports observed more than this many seconds before they land are rejected.
  uint32 public immutable i_maxReportAge;

  Hot internal s_hot;
  Cold internal s_cold;
  mapping(address => bool) public isGuardian;

  constructor(
    InitParams memory p
  ) CREReceiver(p.chainSelector, p.identity) Ownable(p.owner) {
    if (p.maxReportAge < MAX_CLOCK_SKEW || p.maxReportAge > 1 hours) revert OutOfBounds();
    i_maxReportAge = p.maxReportAge;
    s_hot.lastObservedAt = uint40(block.timestamp); // the heartbeat clock starts at deployment
    _setLiveness(p.heartbeat, p.staleLevel);
    _setPermissions(p.permissions == 0 ? DEFAULT_PERMISSIONS : p.permissions);
    _setRelaxDelay(p.relaxDelay);
  }

  // ─── Integrator views ────────────────────────────────────────────────────

  /// @inheritdoc ITripwireGuard
  function isAllowed(
    uint16 actions
  ) public view returns (bool) {
    Hot memory h = s_hot;
    uint16 allowed = uint16(h.permissions >> (16 * uint8(_effective(h))));
    return allowed & actions == actions;
  }

  /// @inheritdoc ITripwireGuard
  function effectiveLevel() external view returns (Level) {
    return _effective(s_hot);
  }

  /// @inheritdoc ITripwireGuard
  function isBorrowAllowed() external view returns (bool) {
    return isAllowed(Actions.BORROW);
  }

  /// @inheritdoc ITripwireGuard
  function isLiquidationAllowed() external view returns (bool) {
    return isAllowed(Actions.LIQUIDATE);
  }

  /// @inheritdoc ITripwireGuard
  function status() external view returns (Status memory s) {
    Hot memory h = s_hot;
    Cold memory c = s_cold;
    bool stale = _isStale(h);
    s = Status({
      level: h.level,
      effectiveLevel: _effective(h),
      stale: stale,
      reasons: stale ? h.reasons | Reasons.LIVENESS : h.reasons,
      epoch: h.epoch,
      lastObservedAt: h.lastObservedAt,
      heartbeat: h.heartbeat,
      staleLevel: h.staleLevel,
      lastReportedLevel: h.lastReportedLevel,
      lastReportedReasons: h.lastReportedReasons,
      permissions: h.permissions,
      relaxPending: c.relaxReadyAt != 0,
      relaxTarget: c.relaxTarget,
      relaxReadyAt: c.relaxReadyAt,
      trippedAt: c.trippedAt
    });
  }

  function permissionsAt(
    Level level
  ) external view returns (uint16) {
    return uint16(s_hot.permissions >> (16 * uint8(level)));
  }

  // ─── CRE reports ─────────────────────────────────────────────────────────

  /// @dev Payload: abi.encode(uint64 chainSelector, address target, uint40 observedAt, uint8 level, uint32 reasons,
  /// bytes32 evidenceHash, uint256 metrics). `metrics` is opaque here and only emitted (layout in docs/REPORT.md).
  function _processReport(
    bytes calldata report
  ) internal override {
    (,, uint40 observedAt, uint8 rawLevel, uint32 reasons, bytes32 evidenceHash, uint256 metrics) =
      abi.decode(report, (uint64, address, uint40, uint8, uint32, bytes32, uint256));
    if (rawLevel > MAX_LEVEL) revert InvalidLevel(rawLevel);

    Hot memory h = s_hot;
    if (observedAt <= h.lastObservedAt) revert OutOfOrderReport(observedAt, h.lastObservedAt);
    if (observedAt > block.timestamp + MAX_CLOCK_SKEW) revert ReportFromFuture(observedAt);
    if (block.timestamp > uint256(observedAt) + i_maxReportAge) revert ReportTooOld(observedAt);

    Level reported = Level(rawLevel);
    h.lastObservedAt = observedAt;
    h.lastReportedLevel = reported;
    h.lastReportedReasons = reasons;

    if (reported > h.level) {
      emit Tripped(h.level, reported, reasons, evidenceHash, msg.sender);
      _raise(h, reported, reasons);
    } else if (reported == h.level && reported != Level.Normal) {
      h.reasons |= reasons;
    }
    s_hot = h;
    emit Observed(observedAt, reported, reasons, evidenceHash, metrics);
  }

  // ─── Guardians ───────────────────────────────────────────────────────────

  /// @notice Manual tighten (incident response). Guardians can never loosen anything.
  function trip(
    Level to,
    uint32 reasons
  ) external onlyGuardian {
    Hot memory h = s_hot;
    if (to <= h.level) revert NotTighter(h.level, to);
    emit Tripped(h.level, to, reasons | Reasons.MANUAL, bytes32(0), msg.sender);
    _raise(h, to, reasons | Reasons.MANUAL);
    s_hot = h;
  }

  function cancelRelax() external onlyGuardian {
    if (s_cold.relaxReadyAt == 0) revert NoPendingRelax();
    s_cold.relaxReadyAt = 0;
    emit RelaxCancelled(msg.sender);
  }

  // ─── Relax (two keys: governance + watcher) ──────────────────────────────

  function proposeRelax(
    Level to
  ) external onlyOwner {
    Hot memory h = s_hot;
    if (to >= h.level) revert NotLooser(h.level, to);
    Cold memory c = s_cold;
    c.relaxTarget = to;
    c.relaxProposedAt = uint40(block.timestamp);
    c.relaxReadyAt = uint40(block.timestamp + c.relaxDelay);
    c.relaxEpoch = h.epoch;
    s_cold = c;
    emit RelaxProposed(to, c.relaxReadyAt, h.epoch);
  }

  /// @notice Anyone can execute a matured proposal: governance already approved it, the watcher must still agree.
  function executeRelax() external {
    Hot memory h = s_hot;
    Cold memory c = s_cold;
    if (c.relaxReadyAt == 0) revert NoPendingRelax();
    if (block.timestamp < c.relaxReadyAt) revert RelaxNotReady(c.relaxReadyAt);
    if (c.relaxEpoch != h.epoch) revert RelaxSuperseded();
    if (_isStale(h)) revert WatcherStale();
    if (h.lastObservedAt <= c.relaxProposedAt) revert NoFreshEvidence();
    if (h.lastReportedLevel > c.relaxTarget) revert WatcherDisagrees(h.lastReportedLevel, c.relaxTarget);

    emit Relaxed(h.level, c.relaxTarget);
    h.level = c.relaxTarget;
    h.reasons = c.relaxTarget == Level.Normal ? 0 : h.lastReportedReasons;
    unchecked {
      ++h.epoch;
    }
    c.relaxReadyAt = 0;
    s_hot = h;
    s_cold = c;
  }

  // ─── Governance configuration (owner should be a timelock / multisig) ────

  function setGuardian(
    address guardian,
    bool enabled
  ) external onlyOwner {
    if (guardian == address(0)) revert ZeroAddress();
    isGuardian[guardian] = enabled;
    emit GuardianSet(guardian, enabled);
  }

  function setPermissions(
    uint64 permissions
  ) external onlyOwner {
    _setPermissions(permissions);
  }

  function setLiveness(
    uint32 heartbeat,
    Level staleLevel
  ) external onlyOwner {
    _setLiveness(heartbeat, staleLevel);
  }

  function setRelaxDelay(
    uint32 relaxDelay
  ) external onlyOwner {
    _setRelaxDelay(relaxDelay);
  }

  function setWorkflowIdentity(
    WorkflowIdentity calldata identity
  ) external onlyOwner {
    _setWorkflowIdentity(identity);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  modifier onlyGuardian() {
    if (!isGuardian[msg.sender] && msg.sender != owner()) revert NotGuardian(msg.sender);
    _;
  }

  function _raise(
    Hot memory h,
    Level to,
    uint32 reasons
  ) internal {
    h.level = to;
    h.reasons |= reasons;
    unchecked {
      ++h.epoch; // invalidates any pending relax proposal
    }
    s_cold.trippedAt = uint40(block.timestamp);
  }

  function _isStale(
    Hot memory h
  ) internal view returns (bool) {
    return block.timestamp > uint256(h.lastObservedAt) + h.heartbeat;
  }

  function _effective(
    Hot memory h
  ) internal view returns (Level) {
    return _isStale(h) && h.staleLevel > h.level ? h.staleLevel : h.level;
  }

  function _setPermissions(
    uint64 permissions
  ) internal {
    // Each level's allow-list must be a subset of the one below it: tightening can never re-enable an action.
    for (uint256 level = 1; level <= MAX_LEVEL; ++level) {
      uint16 lower = uint16(permissions >> (16 * (level - 1)));
      uint16 upper = uint16(permissions >> (16 * level));
      if (upper & ~lower != 0) revert NonMonotonePermissions(permissions);
    }
    s_hot.permissions = permissions;
    emit PermissionsSet(permissions);
  }

  function _setLiveness(
    uint32 heartbeat,
    Level staleLevel
  ) internal {
    if (heartbeat < MIN_HEARTBEAT || heartbeat > MAX_HEARTBEAT) revert OutOfBounds();
    s_hot.heartbeat = heartbeat;
    s_hot.staleLevel = staleLevel;
    emit LivenessSet(heartbeat, staleLevel);
  }

  function _setRelaxDelay(
    uint32 relaxDelay
  ) internal {
    if (relaxDelay < MIN_RELAX_DELAY || relaxDelay > MAX_RELAX_DELAY) revert OutOfBounds();
    s_cold.relaxDelay = relaxDelay;
    emit RelaxDelaySet(relaxDelay);
  }

  function supportsInterface(
    bytes4 interfaceId
  ) public view override returns (bool) {
    return interfaceId == type(ITripwireGuard).interfaceId || super.supportsInterface(interfaceId);
  }
}
