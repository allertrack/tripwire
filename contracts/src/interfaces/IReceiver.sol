// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice CRE report receiver (same interface ID as `@chainlink/contracts` keystone `IReceiver`).
/// @dev The Forwarder only delivers to contracts that report support for this interface through ERC-165.
interface IReceiver is IERC165 {
  /// @param metadata abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner[, bytes2 reportId]).
  /// @param report The workflow's ABI-encoded payload.
  function onReport(
    bytes calldata metadata,
    bytes calldata report
  ) external;
}
