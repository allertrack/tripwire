// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireProtected} from "../integrations/TripwireProtected.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {ITripwireGuard} from "../interfaces/ITripwireGuard.sol";
import {ITripwireMonitored} from "../interfaces/ITripwireMonitored.sol";
import {SlidingWindow} from "../libraries/SlidingWindow.sol";
import {Actions} from "../libraries/TripwireTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title GuardedLendingPool
/// @notice Minimal single-market lending pool (one collateral asset, one debt asset, no interest) that shows how a
/// protocol wires in Tripwire: one modifier on each gated entry point and one view for the watcher.
/// Risk-reducing actions (supply, deposit collateral, repay) are never gated. Deeply underwater positions
/// (health factor < 0.95) stay liquidatable at every level, the same rule Aave V3 applies to its oracle sentinel.
/// @dev Demo scope: no interest accrual, no reserve factor, no bad-debt socialisation.
contract GuardedLendingPool is ITripwireMonitored, TripwireProtected, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using SlidingWindow for SlidingWindow.Window;

  error ZeroAmount();
  error InsufficientLiquidity(uint256 available);
  error InsufficientBalance(uint256 balance);
  error Undercollateralized(uint256 healthFactor);
  error PositionHealthy(uint256 healthFactor);
  error InvalidPrice(int256 price);

  event Supplied(address indexed user, uint256 amount);
  event Withdrawn(address indexed user, uint256 amount);
  event CollateralDeposited(address indexed user, uint256 amount);
  event CollateralWithdrawn(address indexed user, uint256 amount);
  event Borrowed(address indexed user, uint256 amount);
  event Repaid(address indexed payer, address indexed borrower, uint256 amount);
  event Liquidated(address indexed liquidator, address indexed borrower, uint256 repaid, uint256 seized);

  uint256 public constant LTV_BPS = 7_500;
  uint256 public constant LIQUIDATION_THRESHOLD_BPS = 8_000;
  uint256 public constant LIQUIDATION_BONUS_BPS = 500;
  uint256 public constant CLOSE_FACTOR_BPS = 5_000;
  /// @dev Below this health factor liquidations bypass the guard (Aave V3: MINIMUM_HEALTH_FACTOR_LIQUIDATION_THRESHOLD).
  uint256 public constant FORCE_LIQUIDATION_HF = 0.95e18;
  uint256 internal constant BPS = 10_000;
  uint256 internal constant WAD = 1e18;

  IERC20 public immutable collateralAsset;
  IERC20 public immutable debtAsset;
  AggregatorV3Interface public immutable oracle;
  uint32 public immutable windowSeconds;
  /// @dev collateral amount * price * i_valueNum / i_valueDen = value in debt-asset units.
  uint256 internal immutable i_valueNum;
  uint256 internal immutable i_valueDen;

  uint256 public totalSupplied;
  uint256 public totalBorrowed;
  mapping(address => uint256) public suppliedOf;
  mapping(address => uint256) public collateralOf;
  mapping(address => uint256) public debtOf;
  SlidingWindow.Window internal s_outflow;

  constructor(
    IERC20Metadata collateral,
    IERC20Metadata debt,
    AggregatorV3Interface oracle_,
    ITripwireGuard guard,
    uint32 windowSeconds_
  ) TripwireProtected(guard) {
    collateralAsset = collateral;
    debtAsset = debt;
    oracle = oracle_;
    windowSeconds = windowSeconds_;
    i_valueNum = 10 ** debt.decimals();
    i_valueDen = 10 ** (uint256(collateral.decimals()) + oracle_.decimals());
  }

  // ─── Lenders ─────────────────────────────────────────────────────────────

  function supply(
    uint256 amount
  ) external nonReentrant {
    if (amount == 0) revert ZeroAmount();
    debtAsset.safeTransferFrom(msg.sender, address(this), amount);
    suppliedOf[msg.sender] += amount;
    totalSupplied += amount;
    emit Supplied(msg.sender, amount);
  }

  function withdraw(
    uint256 amount
  ) external nonReentrant whenAllowed(Actions.WITHDRAW) {
    if (amount == 0) revert ZeroAmount();
    uint256 balance = suppliedOf[msg.sender];
    if (amount > balance) revert InsufficientBalance(balance);
    _requireLiquidity(amount);
    suppliedOf[msg.sender] = balance - amount;
    totalSupplied -= amount;
    s_outflow.record(amount, windowSeconds);
    debtAsset.safeTransfer(msg.sender, amount);
    emit Withdrawn(msg.sender, amount);
  }

  // ─── Borrowers ───────────────────────────────────────────────────────────

  function depositCollateral(
    uint256 amount
  ) external nonReentrant {
    if (amount == 0) revert ZeroAmount();
    collateralAsset.safeTransferFrom(msg.sender, address(this), amount);
    collateralOf[msg.sender] += amount;
    emit CollateralDeposited(msg.sender, amount);
  }

  function withdrawCollateral(
    uint256 amount
  ) external nonReentrant whenAllowed(Actions.WITHDRAW) {
    if (amount == 0) revert ZeroAmount();
    uint256 balance = collateralOf[msg.sender];
    if (amount > balance) revert InsufficientBalance(balance);
    collateralOf[msg.sender] = balance - amount;
    if (debtOf[msg.sender] != 0) {
      uint256 hf = healthFactor(msg.sender);
      if (hf < WAD) revert Undercollateralized(hf);
    }
    collateralAsset.safeTransfer(msg.sender, amount);
    emit CollateralWithdrawn(msg.sender, amount);
  }

  function borrow(
    uint256 amount
  ) external nonReentrant whenAllowed(Actions.BORROW) {
    if (amount == 0) revert ZeroAmount();
    _requireLiquidity(amount);
    uint256 debt = debtOf[msg.sender] + amount;
    uint256 maxDebt = collateralValue(msg.sender) * LTV_BPS / BPS;
    if (debt > maxDebt) revert Undercollateralized(_healthFactor(collateralValue(msg.sender), debt));
    debtOf[msg.sender] = debt;
    totalBorrowed += amount;
    s_outflow.record(amount, windowSeconds);
    debtAsset.safeTransfer(msg.sender, amount);
    emit Borrowed(msg.sender, amount);
  }

  /// @notice Repays up to the outstanding debt of `borrower`. Never gated.
  function repay(
    uint256 amount,
    address borrower
  ) external nonReentrant returns (uint256 repaid) {
    repaid = Math.min(amount, debtOf[borrower]);
    if (repaid == 0) revert ZeroAmount();
    debtAsset.safeTransferFrom(msg.sender, address(this), repaid);
    debtOf[borrower] -= repaid;
    totalBorrowed -= repaid;
    emit Repaid(msg.sender, borrower, repaid);
  }

  // ─── Liquidators ─────────────────────────────────────────────────────────

  function liquidate(
    address borrower,
    uint256 repayAmount
  ) external nonReentrant returns (uint256 repaid, uint256 seized) {
    uint256 price = _price();
    uint256 debt = debtOf[borrower];
    uint256 collateral = collateralOf[borrower];
    uint256 hf = _healthFactor(_value(collateral, price), debt);
    if (hf >= WAD) revert PositionHealthy(hf);
    // A suspicious oracle must not trigger liquidations, unless the position is too far gone to wait.
    if (hf >= FORCE_LIQUIDATION_HF && !tripwire.isAllowed(Actions.LIQUIDATE)) {
      revert TripwirePaused(Actions.LIQUIDATE);
    }

    uint256 closeFactor = hf < FORCE_LIQUIDATION_HF ? BPS : CLOSE_FACTOR_BPS;
    repaid = Math.min(repayAmount, debt * closeFactor / BPS);
    if (repaid == 0) revert ZeroAmount();
    seized = Math.mulDiv(repaid, i_valueDen * (BPS + LIQUIDATION_BONUS_BPS), price * i_valueNum * BPS);
    if (seized > collateral) {
      seized = collateral;
      repaid = Math.mulDiv(collateral, price * i_valueNum * BPS, i_valueDen * (BPS + LIQUIDATION_BONUS_BPS));
    }

    debtAsset.safeTransferFrom(msg.sender, address(this), repaid);
    debtOf[borrower] = debt - repaid;
    totalBorrowed -= repaid;
    collateralOf[borrower] = collateral - seized;
    collateralAsset.safeTransfer(msg.sender, seized);
    emit Liquidated(msg.sender, borrower, repaid, seized);
  }

  // ─── Views ───────────────────────────────────────────────────────────────

  /// @inheritdoc ITripwireMonitored
  function riskSnapshot() external view returns (RiskSnapshot memory s) {
    (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
    s = RiskSnapshot({
      totalSupplied: totalSupplied,
      totalBorrowed: totalBorrowed,
      windowOutflow: s_outflow.value(windowSeconds),
      windowSeconds: windowSeconds,
      price: answer,
      priceUpdatedAt: updatedAt,
      priceDecimals: oracle.decimals()
    });
  }

  function collateralValue(
    address user
  ) public view returns (uint256) {
    return _value(collateralOf[user], _price());
  }

  /// @notice Health factor in WAD; type(uint256).max without debt.
  function healthFactor(
    address user
  ) public view returns (uint256) {
    return _healthFactor(collateralValue(user), debtOf[user]);
  }

  function availableLiquidity() public view returns (uint256) {
    return totalSupplied - totalBorrowed;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  function _price() internal view returns (uint256) {
    (, int256 answer,,,) = oracle.latestRoundData();
    if (answer <= 0) revert InvalidPrice(answer);
    return uint256(answer);
  }

  function _value(
    uint256 collateral,
    uint256 price
  ) internal view returns (uint256) {
    return Math.mulDiv(collateral, price * i_valueNum, i_valueDen);
  }

  function _healthFactor(
    uint256 value,
    uint256 debt
  ) internal pure returns (uint256) {
    if (debt == 0) return type(uint256).max;
    return Math.mulDiv(value * LIQUIDATION_THRESHOLD_BPS, WAD, debt * BPS);
  }

  function _requireLiquidity(
    uint256 amount
  ) internal view {
    uint256 available = availableLiquidity();
    if (amount > available) revert InsufficientLiquidity(available);
  }
}
