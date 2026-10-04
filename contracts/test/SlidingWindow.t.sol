// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SlidingWindow} from "../src/libraries/SlidingWindow.sol";
import {Test} from "forge-std/Test.sol";

contract SlidingWindowHarness {
  using SlidingWindow for SlidingWindow.Window;

  SlidingWindow.Window internal w;
  uint256 public immutable period;

  constructor(
    uint256 period_
  ) {
    period = period_;
  }

  function record(
    uint256 amount
  ) external {
    w.record(amount, period);
  }

  function value() external view returns (uint256) {
    return SlidingWindow.value(w, period);
  }
}

contract SlidingWindowTest is Test {
  uint256 internal constant PERIOD = 1 hours;
  SlidingWindowHarness internal h;

  struct Entry {
    uint256 at;
    uint256 amount;
  }

  Entry[] internal entries;

  function setUp() public {
    vm.warp(1_000_000);
    h = new SlidingWindowHarness(PERIOD);
  }

  function test_emptyIsZero() public view {
    assertEq(h.value(), 0);
  }

  function test_rollsAcrossWindows() public {
    h.record(100);
    vm.warp(block.timestamp + PERIOD / 2);
    h.record(50);
    assertEq(h.value(), 150);
    vm.warp(block.timestamp + PERIOD / 2); // new fixed window starts: previous = 150, weight 1
    assertEq(h.value(), 150);
    vm.warp(block.timestamp + PERIOD / 2); // weight 1/2
    assertEq(h.value(), 75);
    vm.warp(block.timestamp + 2 * PERIOD);
    assertEq(h.value(), 0);
  }

  /// @dev The estimate never exceeds the true total of the last two fixed windows and never misses anything
  /// recorded in the current fixed window (standard sliding-window-counter bounds).
  function testFuzz_bounds(
    uint32[12] memory gaps,
    uint64[12] memory amounts
  ) public {
    for (uint256 i; i < gaps.length; ++i) {
      vm.warp(block.timestamp + bound(gaps[i], 0, PERIOD));
      uint256 amount = bound(amounts[i], 0, 1e24);
      h.record(amount);
      entries.push(Entry(block.timestamp, amount));
    }
    // Fixed windows are aligned to the first record.
    uint256 first = entries[0].at;
    uint256 windowStart = first + ((block.timestamp - first) / PERIOD) * PERIOD;
    uint256 inCurrent;
    uint256 inLastTwo;
    for (uint256 i; i < entries.length; ++i) {
      if (entries[i].at >= windowStart) inCurrent += entries[i].amount;
      if (entries[i].at + PERIOD >= windowStart) inLastTwo += entries[i].amount;
    }
    uint256 v = h.value();
    assertGe(v, inCurrent);
    assertLe(v, inLastTwo);
  }
}
