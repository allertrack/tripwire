// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IReceiver} from "../interfaces/IReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Authenticates CRE reports and binds each one to a single (chain, receiver) pair.
/// @dev Every report starts with two ABI words: `uint64 chainSelector, address target`.
/// - The Forwarder's DON signatures cover the report but not the receiver it is delivered to, so without the
///   `target` word a signed report for one guard could be replayed into another guard on the same chain.
/// - The `chainSelector` word closes cross-chain replay (CRE docs, "Replay attacks").
/// - `trustForwarderOnly` exists only for `cre workflow simulate`, whose MockKeystoneForwarder delivers no workflow
///   metadata and checks no signatures. Never set it with a production KeystoneForwarder.
abstract contract CREReceiver is IReceiver {
  error InvalidForwarder(address sender);
  error WorkflowIdentityNotConfigured();
  error InvalidWorkflowId(bytes32 received);
  error InvalidWorkflowOwner(address received);
  error InvalidWorkflowName(bytes10 received);
  error InvalidMetadata();
  error WrongChain(uint64 received);
  error WrongTarget(address received);
  error ZeroAddress();

  event WorkflowIdentitySet(
    address forwarder, bytes32 workflowId, address workflowOwner, bytes10 workflowName, bool trustForwarderOnly
  );

  struct WorkflowIdentity {
    address forwarder; // KeystoneForwarder (MockKeystoneForwarder for simulation).
    bytes32 workflowId; // Optional: pins one exact workflow build (changes on every redeploy).
    address workflowOwner; // Optional: pins the workflow owner. Recommended in production.
    bytes10 workflowName; // Optional, only checked together with workflowOwner.
    bool trustForwarderOnly; // SIMULATION ONLY.
  }

  /// @dev bytes32 workflowId ++ bytes10 workflowName ++ address workflowOwner (the production Forwarder appends a
  /// 2-byte reportId, so only a minimum length is enforced).
  uint256 internal constant METADATA_MIN_LENGTH = 62;

  uint64 public immutable i_chainSelector;

  WorkflowIdentity internal s_identity;

  constructor(
    uint64 chainSelector,
    WorkflowIdentity memory identity
  ) {
    i_chainSelector = chainSelector;
    _setWorkflowIdentity(identity);
  }

  /// @inheritdoc IReceiver
  function onReport(
    bytes calldata metadata,
    bytes calldata report
  ) external {
    _authenticate(metadata);
    (uint64 chainSelector, address target) = abi.decode(report[:64], (uint64, address));
    if (chainSelector != i_chainSelector) revert WrongChain(chainSelector);
    if (target != address(this)) revert WrongTarget(target);
    _processReport(report);
  }

  function supportsInterface(
    bytes4 interfaceId
  ) public view virtual returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  function getWorkflowIdentity() external view returns (WorkflowIdentity memory) {
    return s_identity;
  }

  /// @dev Called with a report already bound to this chain and this contract.
  function _processReport(
    bytes calldata report
  ) internal virtual;

  function _authenticate(
    bytes calldata metadata
  ) internal view {
    WorkflowIdentity memory id = s_identity;
    if (msg.sender != id.forwarder) revert InvalidForwarder(msg.sender);
    if (id.trustForwarderOnly) return;
    if (metadata.length < METADATA_MIN_LENGTH) revert InvalidMetadata();

    bytes32 workflowId = bytes32(metadata[0:32]);
    bytes10 workflowName = bytes10(metadata[32:42]);
    address workflowOwner = address(bytes20(metadata[42:62]));

    if (id.workflowId != bytes32(0) && workflowId != id.workflowId) revert InvalidWorkflowId(workflowId);
    if (id.workflowOwner != address(0)) {
      if (workflowOwner != id.workflowOwner) revert InvalidWorkflowOwner(workflowOwner);
      if (id.workflowName != bytes10(0) && workflowName != id.workflowName) revert InvalidWorkflowName(workflowName);
    }
  }

  function _setWorkflowIdentity(
    WorkflowIdentity memory id
  ) internal {
    if (id.forwarder == address(0)) revert ZeroAddress();
    // A production identity must pin something beyond the Forwarder, or any workflow could report.
    if (!id.trustForwarderOnly && id.workflowId == bytes32(0) && id.workflowOwner == address(0)) {
      revert WorkflowIdentityNotConfigured();
    }
    s_identity = id;
    emit WorkflowIdentitySet(id.forwarder, id.workflowId, id.workflowOwner, id.workflowName, id.trustForwarderOnly);
  }
}
