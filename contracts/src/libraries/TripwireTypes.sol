// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Severity ladder of a protected protocol. Higher is stricter.
/// @dev Workflow reports and guardians can only move a guard up this ladder; moving down takes a timelocked
/// governance proposal that the watcher's latest observation must agree with.
enum Level {
  Normal, // everything allowed
  Caution, // new risk paused (default: borrow, mint)
  Restricted, // oracle-dependent actions paused too (default: + liquidate, bridge out)
  Frozen // only risk-reducing actions (repay, deposit), which are never gated
}

/// @notice Gated action bits. A guard stores one 16-bit allow-list per level.
/// @dev Risk-reducing actions (repay, add collateral, supply) are deliberately absent: they must never be blocked.
library Actions {
  uint16 internal constant BORROW = 1 << 0;
  uint16 internal constant WITHDRAW = 1 << 1;
  uint16 internal constant LIQUIDATE = 1 << 2;
  uint16 internal constant MINT = 1 << 3;
  uint16 internal constant BRIDGE_OUT = 1 << 4;
  uint16 internal constant SWAP = 1 << 5;
  // Bits 6..15 are free for integrator-defined actions.
  uint16 internal constant ALL = type(uint16).max;
}

/// @notice Why a guard tightened. Bitmap, accumulated while the guard stays tight.
/// @dev Bits 0..15 are produced by the CRE workflow (see workflow/tripwire/src/codes.ts), 30..31 by the guard.
library Reasons {
  uint32 internal constant ORACLE_DEVIATION = 1 << 0;
  uint32 internal constant ORACLE_STALE = 1 << 1;
  uint32 internal constant REFERENCE_DIVERGENCE = 1 << 2;
  uint32 internal constant REFERENCE_UNAVAILABLE = 1 << 3;
  uint32 internal constant UTILIZATION = 1 << 4;
  uint32 internal constant OUTFLOW_VELOCITY = 1 << 5;
  uint32 internal constant MANUAL = 1 << 30;
  /// @dev Never stored: added to `status().reasons` while the watcher's heartbeat is overdue.
  uint32 internal constant LIVENESS = 1 << 31;
}
