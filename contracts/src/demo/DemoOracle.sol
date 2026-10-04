// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet stand-in for a market's own price source. It follows a live feed (`source`, e.g. Chainlink) like a
/// real market oracle would, and the owner can override it to rehearse the failures Tripwire must catch:
/// manipulation, depeg, a frozen feed. Without a source it is a plain manual oracle.
contract DemoOracle is AggregatorV3Interface, Ownable {
  error RoundNotFound(uint80 roundId);
  error NoSource();
  error DecimalsMismatch(uint8 source, uint8 expected);

  struct Round {
    int256 answer;
    uint64 updatedAt;
  }

  uint8 public immutable decimals;
  AggregatorV3Interface public immutable source;
  string public description;
  /// @notice True while the owner's answers replace the source.
  bool public overridden;
  uint80 public latestRound;
  mapping(uint80 => Round) internal s_rounds;

  event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
  event OverrideCleared();

  constructor(
    uint8 decimals_,
    string memory description_,
    AggregatorV3Interface source_,
    int256 initialAnswer,
    address owner
  ) Ownable(owner) {
    decimals = decimals_;
    description = description_;
    source = source_;
    if (address(source_) == address(0)) {
      _push(initialAnswer, block.timestamp);
    } else if (source_.decimals() != decimals_) {
      revert DecimalsMismatch(source_.decimals(), decimals_);
    }
  }

  function version() external pure returns (uint256) {
    return 1;
  }

  /// @notice Overrides the source with `answer`, stamped now (rehearses manipulation or a depeg).
  function pushAnswer(
    int256 answer
  ) external onlyOwner {
    _push(answer, block.timestamp);
  }

  /// @notice Overrides the source with an answer stamped in the past (rehearses a feed that stopped updating).
  function pushAnswerAt(
    int256 answer,
    uint256 updatedAt
  ) external onlyOwner {
    _push(answer, updatedAt);
  }

  /// @notice Goes back to following the source.
  function clearOverride() external onlyOwner {
    if (address(source) == address(0)) revert NoSource();
    overridden = false;
    emit OverrideCleared();
  }

  function getRoundData(
    uint80 roundId
  ) external view returns (uint80, int256, uint256, uint256, uint80) {
    if (!overridden) return source.getRoundData(roundId);
    Round memory r = s_rounds[roundId];
    if (r.updatedAt == 0) revert RoundNotFound(roundId);
    return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
  }

  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
    if (!overridden) return source.latestRoundData();
    Round memory r = s_rounds[latestRound];
    return (latestRound, r.answer, r.updatedAt, r.updatedAt, latestRound);
  }

  function _push(
    int256 answer,
    uint256 updatedAt
  ) internal {
    uint80 roundId = ++latestRound;
    s_rounds[roundId] = Round({answer: answer, updatedAt: uint64(updatedAt)});
    overridden = true;
    emit AnswerUpdated(answer, roundId, updatedAt);
  }
}
