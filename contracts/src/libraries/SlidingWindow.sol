// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Sliding-window counter in one storage slot: the previous fixed window is weighted by how much of it still
/// overlaps the trailing `period` seconds. O(1) gas per update and per read.
library SlidingWindow {
  struct Window {
    uint40 start; // start of the current fixed window (0 = never used)
    uint96 previous; // total recorded in the previous fixed window
    uint96 current; // total recorded in the current fixed window
  }

  function record(
    Window storage self,
    uint256 amount,
    uint256 period
  ) internal {
    Window memory w = _rolled(self, period);
    w.current = SafeCast.toUint96(uint256(w.current) + amount);
    self.start = w.start;
    self.previous = w.previous;
    self.current = w.current;
  }

  /// @notice Amount recorded over the trailing `period` seconds.
  function value(
    Window memory self,
    uint256 period
  ) internal view returns (uint256) {
    Window memory w = _rolled(self, period);
    uint256 elapsed = block.timestamp - w.start;
    return uint256(w.previous) * (period - elapsed) / period + w.current;
  }

  function _rolled(
    Window memory w,
    uint256 period
  ) private view returns (Window memory) {
    if (w.start == 0) return Window({start: uint40(block.timestamp), previous: 0, current: 0});
    uint256 elapsed = block.timestamp - w.start;
    if (elapsed < period) return w;
    if (elapsed < 2 * period) return Window({start: uint40(w.start + period), previous: w.current, current: 0});
    return Window({start: uint40(block.timestamp - elapsed % period), previous: 0, current: 0});
  }
}
