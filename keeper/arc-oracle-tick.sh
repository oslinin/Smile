#!/usr/bin/env bash
# Keep Arc testnet's mock ETH/USD feed fresh and honest: every run posts the
# current Chainlink ETH/USD answer from Sepolia into the MockV3Aggregator on
# Arc. Arc testnet has no Chainlink feed (docs/arc-testnet-deployment.md), and
# the vaults refuse to quote against a round older than an hour
# (StaleOraclePrice) — without this tick the Arc demo stops trading a few
# hours after the last manual setAnswer. A systemd timer on the dev box runs
# it every 30 minutes (docs/arc-testnet-deployment.md, "Oracle tick").
#
#   PRIVATE_KEY=0x… ./keeper/arc-oracle-tick.sh        # one tick
#   ARC_ORACLE=0x… SEPOLIA_FEED=0x… override the defaults below
set -euo pipefail
: "${PRIVATE_KEY:?set PRIVATE_KEY}"
SEPOLIA_RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
SEPOLIA_FEED=${SEPOLIA_FEED:-0x694AA1769357215DE4FAC081bf1f309aDC325306}
ARC_RPC=${ARC_RPC:-https://rpc.testnet.arc.network}
ARC_ORACLE=${ARC_ORACLE:-0xd525D62124874B690942cfEef78fdC44AD08Eaf4}
ANSWER=$(cast call --rpc-url "$SEPOLIA_RPC" "$SEPOLIA_FEED" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' | sed -n 2p | awk '{print $1}')
[ "$ANSWER" -gt 10000000000 ] || { echo "bad Sepolia answer: $ANSWER" >&2; exit 1; }   # > $100
HASH=$(cast send --rpc-url "$ARC_RPC" --private-key "$PRIVATE_KEY" --json "$ARC_ORACLE" 'setAnswer(int256)' "$ANSWER" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["transactionHash"], d["status"])')
echo "$(date -u +%FT%TZ) Arc mock ETH/USD <- Sepolia Chainlink $(python3 -c "print($ANSWER/1e8)") tx $HASH"
