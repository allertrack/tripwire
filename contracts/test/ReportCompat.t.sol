// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireGuard} from "../src/TripwireGuard.sol";
import {ITripwireGuard} from "../src/interfaces/ITripwireGuard.sol";
import {Level, Reasons} from "../src/libraries/TripwireTypes.sol";
import {GuardFixture} from "./helpers/GuardFixture.sol";

/// @notice Delivers the exact bytes the TypeScript workflow produces (workflow/tripwire/test/golden.test.ts).
/// If either side changes the report layout, one of the two tests fails.
contract ReportCompatTest is GuardFixture {
  address internal constant GOLDEN_GUARD = 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f;
  uint40 internal constant GOLDEN_OBSERVED_AT = 1_790_000_030;
  bytes32 internal constant GOLDEN_EVIDENCE = 0xd4fbc4a7368db3385310885775ead5892696e0a054d3bf67f45d2ccf7fe3984d;
  uint256 internal constant GOLDEN_METRICS = 0x30000003edd410c0000000051b93af6000000003c000007d000000bb8;
  bytes internal constant GOLDEN_REPORT =
    hex"0000000000000000000000000000000000000000000000001e4ba3a26233c8500000000000000000000000005615deb798bb3e4dfa0139dfa1b3d433cc23b72f000000000000000000000000000000000000000000000000000000006ab13b9e00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001d4fbc4a7368db3385310885775ead5892696e0a054d3bf67f45d2ccf7fe3984d000000030000003edd410c0000000051b93af6000000003c000007d000000bb8";

  function setUp() public {
    guard = _deployGuard();
    assertEq(address(guard), GOLDEN_GUARD, "fixture deployment address changed: regenerate the golden report");
  }

  function test_goldenReportFromWorkflow() public {
    vm.warp(GOLDEN_OBSERVED_AT);
    vm.expectEmit(address(guard));
    emit TripwireGuard.Tripped(Level.Normal, Level.Frozen, Reasons.ORACLE_DEVIATION, GOLDEN_EVIDENCE, forwarder);
    vm.expectEmit(address(guard));
    emit TripwireGuard.Observed(
      GOLDEN_OBSERVED_AT, Level.Frozen, Reasons.ORACLE_DEVIATION, GOLDEN_EVIDENCE, GOLDEN_METRICS
    );
    vm.prank(forwarder);
    guard.onReport(_metadata(), GOLDEN_REPORT);

    ITripwireGuard.Status memory s = guard.status();
    assertEq(uint8(s.level), uint8(Level.Frozen));
    assertEq(s.lastObservedAt, GOLDEN_OBSERVED_AT);

    // Metrics layout (docs/REPORT.md), decoded on the Solidity side.
    assertEq(GOLDEN_METRICS & 0xffff, 3_000, "deviation bps");
    assertEq((GOLDEN_METRICS >> 32) & 0xffff, 2_000, "utilization bps");
    assertEq((GOLDEN_METRICS >> 64) & 0xffffffff, 60, "oracle age");
    assertEq((GOLDEN_METRICS >> 96) & type(uint64).max, 3_510e8, "market price");
    assertEq((GOLDEN_METRICS >> 160) & type(uint64).max, 2_700e8, "reference price");
    assertEq(GOLDEN_METRICS >> 224, 3, "sources");
  }
}
