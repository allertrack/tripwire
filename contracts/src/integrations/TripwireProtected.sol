// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITripwireGuard} from "../interfaces/ITripwireGuard.sol";

/// @notice Drop-in base for protocols that can be changed: one modifier per gated entry point.
/// @dev Protocols that cannot be changed but have a pause/sentinel hook (e.g. Aave V3's PriceOracleSentinel) point
/// that hook at the guard directly instead.
abstract contract TripwireProtected {
  error TripwirePaused(uint16 actions);

  ITripwireGuard public immutable tripwire;

  constructor(
    ITripwireGuard guard
  ) {
    tripwire = guard;
  }

  modifier whenAllowed(
    uint16 actions
  ) {
    if (!tripwire.isAllowed(actions)) revert TripwirePaused(actions);
    _;
  }
}
