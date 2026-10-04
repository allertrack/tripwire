// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TripwireGuard} from "../src/TripwireGuard.sol";
import {CREReceiver} from "../src/cre/CREReceiver.sol";
import {DemoOracle} from "../src/demo/DemoOracle.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {GuardedLendingPool} from "../src/demo/GuardedLendingPool.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {Level} from "../src/libraries/TripwireTypes.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys the Tripwire demo market on Monad testnet (or a local fork of it) and seeds it with a healthy book.
/// Env:
///   PRIVATE_KEY            deployer (becomes owner/governance and guardian of the demo)
///   FORWARDER              default: CRE MockKeystoneForwarder on Monad testnet (simulation)
///   TRUST_FORWARDER_ONLY   default: true (simulation forwarder carries no workflow metadata)
///   WORKFLOW_OWNER         pin the CRE workflow owner (production forwarder)
///   CHAINLINK_FEED         seeds the demo oracle with the live Chainlink price (default: ETH/USD on Monad testnet)
///   RELAX_DELAY            default 120 s (demo); production should use hours
contract Deploy is Script {
  uint64 internal constant MONAD_TESTNET_SELECTOR = 2183018362218727504;
  address internal constant MOCK_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
  address internal constant CHAINLINK_ETH_USD = 0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31;

  struct Deployment {
    TripwireGuard guard;
    GuardedLendingPool pool;
    DemoOracle oracle;
    DemoToken weth;
    DemoToken usdc;
  }

  function run() external returns (Deployment memory d) {
    uint256 pk = vm.envUint("PRIVATE_KEY");
    address deployer = vm.addr(pk);
    address forwarder = vm.envOr("FORWARDER", MOCK_FORWARDER);
    address feed = vm.envOr("CHAINLINK_FEED", CHAINLINK_ETH_USD);

    int256 seedPrice = 2_700e8;
    if (feed.code.length != 0) (, seedPrice,,,) = AggregatorV3Interface(feed).latestRoundData();

    vm.startBroadcast(pk);
    d.weth = new DemoToken("Tripwire Demo WETH", "tWETH", 18, 1e18, deployer);
    d.usdc = new DemoToken("Tripwire Demo USDC", "tUSDC", 6, 10_000e6, deployer);
    d.oracle = new DemoOracle(8, "tWETH / USD (market oracle)", seedPrice, deployer);
    d.guard = new TripwireGuard(
      TripwireGuard.InitParams({
        chainSelector: MONAD_TESTNET_SELECTOR,
        owner: deployer,
        identity: CREReceiver.WorkflowIdentity({
          forwarder: forwarder,
          workflowId: bytes32(0),
          workflowOwner: vm.envOr("WORKFLOW_OWNER", address(0)),
          workflowName: bytes10(0),
          trustForwarderOnly: vm.envOr("TRUST_FORWARDER_ONLY", true)
        }),
        heartbeat: uint32(vm.envOr("HEARTBEAT", uint256(15 minutes))),
        staleLevel: Level.Caution,
        relaxDelay: uint32(vm.envOr("RELAX_DELAY", uint256(120))),
        maxReportAge: 5 minutes,
        permissions: 0
      })
    );
    d.pool = new GuardedLendingPool(d.weth, d.usdc, d.oracle, d.guard, 1 hours);

    // A healthy book: 500k supplied, one borrower at 4% utilization.
    d.usdc.mint(deployer, 1_000_000e6);
    d.weth.mint(deployer, 100e18);
    d.usdc.approve(address(d.pool), type(uint256).max);
    d.weth.approve(address(d.pool), type(uint256).max);
    d.pool.supply(500_000e6);
    d.pool.depositCollateral(20e18);
    d.pool.borrow(20_000e6);
    vm.stopBroadcast();

    _write(d, deployer, forwarder, feed);
  }

  function _write(
    Deployment memory d,
    address deployer,
    address forwarder,
    address feed
  ) internal {
    string memory k = "deployment";
    vm.serializeUint(k, "chainId", block.chainid);
    vm.serializeUint(k, "deployedAtBlock", block.number);
    vm.serializeAddress(k, "deployer", deployer);
    vm.serializeAddress(k, "forwarder", forwarder);
    vm.serializeAddress(k, "chainlinkFeed", feed);
    vm.serializeAddress(k, "guard", address(d.guard));
    vm.serializeAddress(k, "pool", address(d.pool));
    vm.serializeAddress(k, "oracle", address(d.oracle));
    vm.serializeAddress(k, "weth", address(d.weth));
    string memory json = vm.serializeAddress(k, "usdc", address(d.usdc));
    string memory path =
      string.concat(vm.projectRoot(), "/deployments/", vm.envOr("DEPLOYMENT_NAME", string("monad-testnet")), ".json");
    vm.writeJson(json, path);
    console2.log("guard ", address(d.guard));
    console2.log("pool  ", address(d.pool));
    console2.log("oracle", address(d.oracle));
    console2.log("written", path);
  }
}
