// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Level, Reasons} from "../../src/libraries/TripwireTypes.sol";
import {GuardFixture} from "../helpers/GuardFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPoolAddressesProvider {
  function owner() external view returns (address);
  function getPool() external view returns (address);
  function getPriceOracle() external view returns (address);
  function getPriceOracleSentinel() external view returns (address);
  function setPriceOracleSentinel(
    address sentinel
  ) external;
}

interface IAavePool {
  function supply(
    address asset,
    uint256 amount,
    address onBehalfOf,
    uint16 referralCode
  ) external;
  function borrow(
    address asset,
    uint256 amount,
    uint256 interestRateMode,
    uint16 referralCode,
    address onBehalfOf
  ) external;
  function liquidationCall(
    address collateralAsset,
    address debtAsset,
    address user,
    uint256 debtToCover,
    bool receiveAToken
  ) external;
  function getUserAccountData(
    address user
  ) external view returns (uint256, uint256, uint256, uint256, uint256, uint256 healthFactor);
}

interface IAaveOracle {
  function getAssetPrice(
    address asset
  ) external view returns (uint256);
}

/// @notice Plugs a TripwireGuard into the real Aave V3 market on Ethereum Sepolia as its PriceOracleSentinel
/// (one governance call, no Aave code changes) and checks that Aave's own borrow and liquidation logic obeys it.
/// Addresses: bgd-labs/aave-address-book, AaveV3Sepolia.
contract AaveV3SentinelForkTest is GuardFixture {
  IPoolAddressesProvider internal constant PROVIDER =
    IPoolAddressesProvider(0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A);
  address internal constant WETH = 0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c;
  address internal constant USDT = 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0; // borrowable, with liquidity at FORK_BLOCK
  uint256 internal constant FORK_BLOCK = 11_842_000;
  uint256 internal constant VARIABLE_RATE = 2;
  /// @dev Aave V3.0 Errors.PRICE_ORACLE_SENTINEL_CHECK_FAILED.
  bytes internal constant SENTINEL_CHECK_FAILED = bytes("59");

  IAavePool internal pool;
  IAaveOracle internal aaveOracle;
  address internal user = makeAddr("aaveUser");
  address internal liquidator = makeAddr("aaveLiquidator");

  function setUp() public {
    vm.createSelectFork(vm.envOr("SEPOLIA_RPC_URL", string("https://ethereum-sepolia-rpc.publicnode.com")), FORK_BLOCK);
    guard = _deployGuard();
    pool = IAavePool(PROVIDER.getPool());
    aaveOracle = IAaveOracle(PROVIDER.getPriceOracle());

    // The single integration step: Aave governance points the market's sentinel at the guard.
    vm.prank(PROVIDER.owner());
    PROVIDER.setPriceOracleSentinel(address(guard));
    assertEq(PROVIDER.getPriceOracleSentinel(), address(guard));

    // A borrower with 10 WETH of collateral.
    deal(WETH, user, 10e18);
    vm.startPrank(user);
    IERC20(WETH).approve(address(pool), type(uint256).max);
    pool.supply(WETH, 10e18, user, 0);
    vm.stopPrank();
  }

  /// @dev USDT (6 decimals) worth `ltvPct`% of the 10 WETH collateral, at Aave's own oracle prices.
  function _borrowAmount(
    uint256 ltvPct
  ) internal view returns (uint256) {
    return aaveOracle.getAssetPrice(WETH) * 10 * 1e6 * ltvPct / (aaveOracle.getAssetPrice(USDT) * 100);
  }

  function test_aave_borrowWorksAtNormal() public {
    uint256 amount = _borrowAmount(50);
    vm.prank(user);
    pool.borrow(USDT, amount, VARIABLE_RATE, 0, user);
    assertEq(IERC20(USDT).balanceOf(user), amount);
  }

  function test_aave_workflowTripBlocksBorrow() public {
    vm.warp(block.timestamp + 30);
    _deliver(uint8(Level.Caution), Reasons.ORACLE_DEVIATION);

    uint256 amount = _borrowAmount(50);
    vm.prank(user);
    vm.expectRevert(SENTINEL_CHECK_FAILED);
    pool.borrow(USDT, amount, VARIABLE_RATE, 0, user);
  }

  function test_aave_silentWatcherBlocksBorrow() public {
    vm.warp(block.timestamp + HEARTBEAT + 1); // no report for a full heartbeat => Caution
    uint256 amount = _borrowAmount(50);
    vm.prank(user);
    vm.expectRevert(SENTINEL_CHECK_FAILED);
    pool.borrow(USDT, amount, VARIABLE_RATE, 0, user);
  }

  /// @dev Restricted pauses liquidations driven by a suspicious price; Aave still lets positions with HF < 0.95
  /// be liquidated, so a frozen market can never accumulate deep bad debt.
  function test_aave_restrictedPausesLiquidationsAtMarginalHealth() public {
    uint256 price = aaveOracle.getAssetPrice(WETH);
    uint256 amount = _borrowAmount(50);
    vm.prank(user);
    pool.borrow(USDT, amount, VARIABLE_RATE, 0, user);

    // The market's WETH price drops 41%: HF = 0.825 * 0.59 / 0.50 ~ 0.97 (liquidatable, but not < 0.95).
    uint256 dropped = price * 59 / 100;
    vm.mockCall(address(aaveOracle), abi.encodeCall(IAaveOracle.getAssetPrice, (WETH)), abi.encode(dropped));
    (,,,,, uint256 hf) = pool.getUserAccountData(user);
    assertLt(hf, 1e18);
    assertGe(hf, 0.95e18);

    vm.warp(block.timestamp + 30);
    _deliver(uint8(Level.Restricted), Reasons.ORACLE_DEVIATION);

    deal(USDT, liquidator, 1_000_000e6);
    vm.startPrank(liquidator);
    IERC20(USDT).approve(address(pool), type(uint256).max);
    vm.expectRevert(SENTINEL_CHECK_FAILED);
    pool.liquidationCall(WETH, USDT, user, type(uint256).max, false);
    vm.stopPrank();

    // Control: without the sentinel, Aave executes the very same liquidation.
    vm.prank(PROVIDER.owner());
    PROVIDER.setPriceOracleSentinel(address(0));
    vm.prank(liquidator);
    pool.liquidationCall(WETH, USDT, user, type(uint256).max, false);
    assertGt(IERC20(WETH).balanceOf(liquidator), 0);
  }
}
