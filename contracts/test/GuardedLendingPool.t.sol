// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DemoOracle} from "../src/demo/DemoOracle.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {GuardedLendingPool} from "../src/demo/GuardedLendingPool.sol";
import {TripwireProtected} from "../src/integrations/TripwireProtected.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {ITripwireMonitored} from "../src/interfaces/ITripwireMonitored.sol";
import {Actions, Level, Reasons} from "../src/libraries/TripwireTypes.sol";
import {GuardFixture} from "./helpers/GuardFixture.sol";

contract GuardedLendingPoolTest is GuardFixture {
  DemoToken internal weth;
  DemoToken internal usdc;
  DemoOracle internal oracle;
  GuardedLendingPool internal pool;

  address internal lender = makeAddr("lender");
  address internal borrower = makeAddr("borrower");
  address internal liquidator = makeAddr("liquidator");

  int256 internal constant ETH_PRICE = 2_700e8;
  uint32 internal constant WINDOW = 1 hours;

  function setUp() public {
    guard = _deployGuard();
    weth = new DemoToken("Tripwire Demo WETH", "tWETH", 18, 1e18, address(this));
    usdc = new DemoToken("Tripwire Demo USDC", "tUSDC", 6, 10_000e6, address(this));
    oracle =
      new DemoOracle(8, "tWETH / USD (market oracle)", AggregatorV3Interface(address(0)), ETH_PRICE, address(this));
    pool = new GuardedLendingPool(weth, usdc, oracle, guard, WINDOW);

    usdc.mint(lender, 1_000_000e6);
    weth.mint(borrower, 100e18);
    usdc.mint(liquidator, 1_000_000e6);
    vm.prank(lender);
    usdc.approve(address(pool), type(uint256).max);
    vm.startPrank(borrower);
    weth.approve(address(pool), type(uint256).max);
    usdc.approve(address(pool), type(uint256).max);
    vm.stopPrank();
    vm.prank(liquidator);
    usdc.approve(address(pool), type(uint256).max);

    vm.prank(lender);
    pool.supply(500_000e6);
    vm.prank(borrower);
    pool.depositCollateral(10e18); // $27,000
  }

  function _setLevel(
    Level level
  ) internal {
    vm.prank(guardian);
    guard.trip(level, 0);
  }

  // ─── Happy paths ─────────────────────────────────────────────────────────

  function test_borrowUpToLtv() public {
    vm.prank(borrower);
    pool.borrow(20_250e6); // 75% of $27,000
    assertEq(pool.debtOf(borrower), 20_250e6);
    assertEq(usdc.balanceOf(borrower), 20_250e6);
    assertEq(pool.totalBorrowed(), 20_250e6);
    assertEq(pool.healthFactor(borrower), uint256(27_000e6) * 8_000 * 1e18 / (20_250e6 * 10_000));
  }

  function test_borrowAboveLtvReverts() public {
    vm.prank(borrower);
    vm.expectRevert();
    pool.borrow(20_250e6 + 1);
  }

  function test_repayAndWithdrawCollateral() public {
    vm.startPrank(borrower);
    pool.borrow(10_000e6);
    assertEq(pool.repay(type(uint256).max, borrower), 10_000e6);
    pool.withdrawCollateral(10e18);
    vm.stopPrank();
    assertEq(pool.debtOf(borrower), 0);
    assertEq(weth.balanceOf(borrower), 100e18);
  }

  function test_withdrawCollateralKeepsPositionHealthy() public {
    vm.startPrank(borrower);
    pool.borrow(20_000e6);
    vm.expectRevert();
    pool.withdrawCollateral(1e18);
    vm.stopPrank();
  }

  function test_lenderWithdrawLimitedByLiquidity() public {
    vm.prank(borrower);
    pool.borrow(20_000e6);
    vm.prank(lender);
    vm.expectRevert(abi.encodeWithSelector(GuardedLendingPool.InsufficientLiquidity.selector, 480_000e6));
    pool.withdraw(500_000e6);
  }

  function test_liquidationWithBonusAndCloseFactor() public {
    vm.prank(borrower);
    pool.borrow(20_000e6);
    oracle.pushAnswer(2_400e8); // value $24,000, HF = 0.96

    vm.prank(liquidator);
    (uint256 repaid, uint256 seized) = pool.liquidate(borrower, type(uint256).max);
    assertEq(repaid, 10_000e6); // 50% close factor
    assertEq(seized, uint256(10_000e6) * 1e26 * 10_500 / (2_400e8 * 1e6 * 10_000)); // $10,500 of ETH
    assertEq(weth.balanceOf(liquidator), seized);
    assertEq(pool.debtOf(borrower), 10_000e6);
  }

  function test_liquidationOfHealthyPositionReverts() public {
    vm.prank(borrower);
    pool.borrow(10_000e6);
    vm.prank(liquidator);
    vm.expectRevert();
    pool.liquidate(borrower, 1);
  }

  // ─── Tripwire gating ─────────────────────────────────────────────────────

  function test_caution_pausesBorrowOnly() public {
    _setLevel(Level.Caution);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(TripwireProtected.TripwirePaused.selector, Actions.BORROW));
    pool.borrow(1e6);
    vm.prank(lender);
    pool.withdraw(1e6);
  }

  function test_restricted_pausesLiquidationsUnlessDeeplyUnderwater() public {
    vm.prank(borrower);
    pool.borrow(20_000e6);
    oracle.pushAnswer(2_400e8); // HF 0.96: liquidatable, but the oracle may be wrong
    _setLevel(Level.Restricted);

    vm.prank(liquidator);
    vm.expectRevert(abi.encodeWithSelector(TripwireProtected.TripwirePaused.selector, Actions.LIQUIDATE));
    pool.liquidate(borrower, type(uint256).max);

    oracle.pushAnswer(2_000e8); // HF 0.8: too far gone to wait, bypasses the guard with a 100% close factor
    vm.prank(liquidator);
    (uint256 repaid,) = pool.liquidate(borrower, type(uint256).max);
    assertGt(repaid, 10_000e6);
  }

  function test_frozen_onlyRiskReducingActions() public {
    vm.prank(borrower);
    pool.borrow(5_000e6);
    _setLevel(Level.Frozen);

    vm.prank(lender);
    vm.expectRevert(abi.encodeWithSelector(TripwireProtected.TripwirePaused.selector, Actions.WITHDRAW));
    pool.withdraw(1e6);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(TripwireProtected.TripwirePaused.selector, Actions.WITHDRAW));
    pool.withdrawCollateral(1e18);

    // Never gated: repay, add collateral, supply.
    vm.startPrank(borrower);
    pool.repay(5_000e6, borrower);
    pool.depositCollateral(1e18);
    vm.stopPrank();
    vm.prank(lender);
    pool.supply(1e6);
    assertEq(pool.debtOf(borrower), 0);
  }

  /// @dev The attack Tripwire exists for: the market's oracle is pushed 30% above Chainlink and the exchanges.
  function test_scenario_oracleManipulationIsContained() public {
    oracle.pushAnswer(ETH_PRICE * 13 / 10);
    // Before the watcher reacts, the inflated price would let the attacker borrow far above the real 75% LTV.
    assertEq(pool.collateralValue(borrower), 35_100e6);

    // Next workflow run (<= 30 s later): deviation 30% => Frozen.
    vm.warp(block.timestamp + 30);
    _deliver(uint8(Level.Frozen), Reasons.ORACLE_DEVIATION);

    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(TripwireProtected.TripwirePaused.selector, Actions.BORROW));
    pool.borrow(26_000e6);
  }

  // ─── Watcher view ────────────────────────────────────────────────────────

  function test_riskSnapshot() public {
    vm.prank(borrower);
    pool.borrow(20_000e6);
    vm.warp(block.timestamp + 10);
    vm.prank(lender);
    pool.withdraw(30_000e6);

    ITripwireMonitored.RiskSnapshot memory s = pool.riskSnapshot();
    assertEq(s.totalSupplied, 470_000e6);
    assertEq(s.totalBorrowed, 20_000e6);
    assertEq(s.windowOutflow, 50_000e6);
    assertEq(s.windowSeconds, WINDOW);
    assertEq(s.price, ETH_PRICE);
    assertEq(s.priceDecimals, 8);
    assertEq(s.priceUpdatedAt, 1_790_000_000);
  }

  function test_outflowWindowDecays() public {
    vm.prank(lender);
    pool.withdraw(100_000e6);
    assertEq(pool.riskSnapshot().windowOutflow, 100_000e6);
    vm.warp(block.timestamp + WINDOW + WINDOW / 4); // previous window still overlaps 3/4 of the trailing hour
    assertEq(pool.riskSnapshot().windowOutflow, 75_000e6);
    vm.warp(block.timestamp + WINDOW);
    assertEq(pool.riskSnapshot().windowOutflow, 0);
  }

  // ─── Demo oracle ─────────────────────────────────────────────────────────

  /// @dev The deployed demo market follows a live feed and is only overridden to rehearse an attack.
  function test_demoOracle_followsSourceUntilOverridden() public {
    DemoOracle live = new DemoOracle(8, "live feed", AggregatorV3Interface(address(0)), 2_702e8, address(this));
    DemoOracle market = new DemoOracle(8, "market", live, 0, address(this));
    assertFalse(market.overridden());
    (, int256 answer,, uint256 updatedAt,) = market.latestRoundData();
    assertEq(answer, 2_702e8);
    assertEq(updatedAt, block.timestamp);

    vm.warp(block.timestamp + 100);
    market.pushAnswer(3_500e8); // attack
    (, answer,, updatedAt,) = market.latestRoundData();
    assertEq(answer, 3_500e8);
    assertEq(updatedAt, block.timestamp);

    market.clearOverride(); // back to the live feed
    (, answer,,,) = market.latestRoundData();
    assertEq(answer, 2_702e8);
  }

  function test_demoOracle_guards() public {
    DemoOracle manual = new DemoOracle(8, "manual", AggregatorV3Interface(address(0)), 1e8, address(this));
    vm.expectRevert(DemoOracle.NoSource.selector);
    manual.clearOverride();
    DemoOracle sixDecimals = new DemoOracle(6, "6d", AggregatorV3Interface(address(0)), 1e6, address(this));
    vm.expectRevert(abi.encodeWithSelector(DemoOracle.DecimalsMismatch.selector, 6, 8));
    new DemoOracle(8, "mismatch", sixDecimals, 0, address(this));
    vm.prank(lender);
    vm.expectRevert();
    manual.pushAnswer(2e8);
  }

  function testFuzz_borrowNeverExceedsLtv(
    uint256 amount,
    int256 price
  ) public {
    price = bound(price, 1e8, 100_000e8);
    oracle.pushAnswer(price);
    amount = bound(amount, 1, 500_000e6);
    uint256 maxDebt = pool.collateralValue(borrower) * 7_500 / 10_000;
    vm.prank(borrower);
    if (amount > maxDebt) vm.expectRevert();
    pool.borrow(amount);
    assertLe(pool.debtOf(borrower), maxDebt);
  }
}
