// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Level} from "../libraries/TripwireTypes.sol";

/// @notice What a protocol integrates: one view call per gated action.
/// @dev `isBorrowAllowed` / `isLiquidationAllowed` match Aave V3's `IPriceOracleSentinel`, so a guard can be plugged
/// into any Aave V3 market (or fork) with `PoolAddressesProvider.setPriceOracleSentinel(guard)` and no code changes.
interface ITripwireGuard {
  struct Status {
    Level level; // Stored level. Reports and guardians only raise it; `executeRelax` lowers it.
    Level effectiveLevel; // max(level, staleLevel) while the watcher's heartbeat is overdue.
    bool stale; // The watcher missed its heartbeat.
    uint32 reasons; // Accumulated reasons since the last relax (+ LIVENESS while stale).
    uint32 epoch; // Bumped on every trip and relax; a relax proposal is only valid for the epoch it was made in.
    uint40 lastObservedAt; // Workflow timestamp of the latest accepted report.
    uint32 heartbeat; // Max seconds between reports before the guard fails safe to `staleLevel`.
    Level staleLevel;
    Level lastReportedLevel; // The watcher's latest view; a relax needs it to agree.
    uint32 lastReportedReasons;
    uint64 permissions; // 4 x 16-bit allow-lists, level L at bits [16L, 16L+16).
    bool relaxPending;
    Level relaxTarget;
    uint40 relaxReadyAt;
    uint40 trippedAt; // Last time the level went up.
  }

  /// @notice True if every action bit in `actions` is allowed at the current effective level.
  function isAllowed(
    uint16 actions
  ) external view returns (bool);

  function effectiveLevel() external view returns (Level);

  /// @notice Aave V3 `IPriceOracleSentinel.isBorrowAllowed`.
  function isBorrowAllowed() external view returns (bool);

  /// @notice Aave V3 `IPriceOracleSentinel.isLiquidationAllowed`.
  function isLiquidationAllowed() external view returns (bool);

  function status() external view returns (Status memory);
}
