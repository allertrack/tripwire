// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet stand-in for a market's own price source (a DEX TWAP, an exchange-rate adapter, a push oracle).
/// The owner can move it to rehearse the failures Tripwire must catch: manipulation, depeg, a frozen feed.
contract DemoOracle is AggregatorV3Interface, Ownable {
  error RoundNotFound(uint80 roundId);

  struct Round {
    int256 answer;
    uint64 updatedAt;
  }

  uint8 public immutable decimals;
  string public description;
  uint80 public latestRound;
  mapping(uint80 => Round) internal s_rounds;

  event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

  constructor(
    uint8 decimals_,
    string memory description_,
    int256 initialAnswer,
    address owner
  ) Ownable(owner) {
    decimals = decimals_;
    description = description_;
    _push(initialAnswer, block.timestamp);
  }

  function version() external pure returns (uint256) {
    return 1;
  }

  function pushAnswer(
    int256 answer
  ) external onlyOwner {
    _push(answer, block.timestamp);
  }

  /// @notice Pushes an answer with a past timestamp (rehearses a feed that stopped updating).
  function pushAnswerAt(
    int256 answer,
    uint256 updatedAt
  ) external onlyOwner {
    _push(answer, updatedAt);
  }

  function getRoundData(
    uint80 roundId
  ) external view returns (uint80, int256, uint256, uint256, uint80) {
    Round memory r = s_rounds[roundId];
    if (r.updatedAt == 0) revert RoundNotFound(roundId);
    return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
  }

  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
    Round memory r = s_rounds[latestRound];
    return (latestRound, r.answer, r.updatedAt, r.updatedAt, latestRound);
  }

  function _push(
    int256 answer,
    uint256 updatedAt
  ) internal {
    uint80 roundId = ++latestRound;
    s_rounds[roundId] = Round({answer: answer, updatedAt: uint64(updatedAt)});
    emit AnswerUpdated(answer, roundId, updatedAt);
  }
}
