// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only token with an owner mint and a rate-limited public faucet for demo users.
contract DemoToken is ERC20, Ownable {
  error FaucetCooldown(uint256 availableAt);

  uint8 private immutable i_decimals;
  uint256 public immutable faucetAmount;
  uint256 public constant FAUCET_COOLDOWN = 1 hours;
  mapping(address => uint256) public lastFaucet;

  constructor(
    string memory name,
    string memory symbol,
    uint8 decimals_,
    uint256 faucetAmount_,
    address owner
  ) ERC20(name, symbol) Ownable(owner) {
    i_decimals = decimals_;
    faucetAmount = faucetAmount_;
  }

  function decimals() public view override returns (uint8) {
    return i_decimals;
  }

  function mint(
    address to,
    uint256 amount
  ) external onlyOwner {
    _mint(to, amount);
  }

  function faucet() external {
    uint256 availableAt = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
    if (lastFaucet[msg.sender] != 0 && block.timestamp < availableAt) revert FaucetCooldown(availableAt);
    lastFaucet[msg.sender] = block.timestamp;
    _mint(msg.sender, faucetAmount);
  }
}
