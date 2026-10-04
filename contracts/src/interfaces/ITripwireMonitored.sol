// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The one view the Tripwire workflow reads from a protected market (directly, or through a lens contract
/// for protocols that cannot be changed). One call keeps each workflow run inside CRE's 15-reads budget.
interface ITripwireMonitored {
  struct RiskSnapshot {
    uint256 totalSupplied; // Lender liquidity, in debt-asset units.
    uint256 totalBorrowed; // Outstanding debt, in debt-asset units.
    uint256 windowOutflow; // Debt asset that left the market over the trailing window (withdrawals + borrows).
    uint32 windowSeconds; // Length of that window.
    int256 price; // The market's own collateral price, as its oracle reports it.
    uint256 priceUpdatedAt;
    uint8 priceDecimals;
  }

  function riskSnapshot() external view returns (RiskSnapshot memory);
}
