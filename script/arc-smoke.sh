#!/usr/bin/env bash
# End-to-end Smile demo on Arc testnet as plain `cast send` transactions:
# main vault (authorize → ship → buy) and SpreadVault (open → ship → buy).
#
# Why not `forge script`? Arc's USDC ERC-20 interface (0x3600…0000) is a
# native-asset system contract; forge's local pre-broadcast simulation
# (revm) can't execute it from fetched bytecode and dies with
# StackUnderflow before anything is sent. `cast send` skips the local
# simulation — the node executes, which is what MetaMask does too.
#
#   PRIVATE_KEY=0x… ./script/arc-smoke.sh            # addresses from broadcast/Deploy.s.sol/5042002
#   UNITS=10000000000000000 ./script/arc-smoke.sh    # 0.01 units — faucet-sized balances
#
# Env: PRIVATE_KEY (deployer = LP = buyer = fee recipient), optional RPC
# (default Arc testnet), UNITS (WAD, default 1e18), and the contract
# addresses (defaults read from the latest Deploy.s.sol broadcast on 5042002).
set -euo pipefail

RPC=${RPC:-https://rpc.testnet.arc.network}
UNITS=${UNITS:-1000000000000000000}
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
: "${PRIVATE_KEY:?set PRIVATE_KEY}"
ME=$(cast wallet address --private-key "$PRIVATE_KEY")

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BROADCAST="$ROOT/broadcast/Deploy.s.sol/5042002/run-latest.json"
addr_of() { python3 -c "
import json,sys
d=json.load(open('$BROADCAST'))
for tx in d['transactions']:
    if tx.get('contractName')=='$1': print(tx['contractAddress'])
" | tail -1; }
VAULT=${VAULT:-$(addr_of AquaCollateralVault)}
SPREAD=${SPREAD:-$(addr_of SpreadVault)}
AQUA=${AQUA:-$(addr_of Aqua)}
WETH=${WETH:-$(addr_of MockERC20)}
USDC=${USDC:-0x3600000000000000000000000000000000000000}

send() { cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json "$@" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["transactionHash"], "status", d["status"])'; }
call() { cast call --rpc-url "$RPC" "$@"; }

echo "deployer $ME  units $UNITS"
echo "vault $VAULT  spread $SPREAD  aqua $AQUA  weth $WETH  usdc $USDC"
echo "USDC before: $(call $USDC 'balanceOf(address)(uint256)' $ME)"
EXPIRY=$(( $(date +%s) + 30*86400 ))

# Parses `cast call --json` output of getShipParams into cast-send-able args.
ship_args() { python3 -c '
import json,sys
app,strategy,tokens,amounts=json.load(sys.stdin)
print(app); print(strategy); print("["+",".join(tokens)+"]"); print("["+",".join(str(int(a)) for a in amounts)+"]")'; }

echo; echo "── main vault: covered-call range, real-USDC premium ──"
send $WETH "approve(address,uint256)" $AQUA $MAX >/dev/null
send $USDC "approve(address,uint256)" $AQUA $MAX >/dev/null
AUTH=$(call $VAULT 'nextAuthId()(uint256)')
echo "authorizeRange (authId $AUTH): $(send $VAULT 'authorizeRange(uint256,uint256,uint256,uint256,address,address,bool)' 2800000000000000000000 3200000000000000000000 $EXPIRY 5000000000000000000 $WETH $USDC true)"
mapfile -t S < <(call $VAULT 'getShipParams(uint256)(address,bytes,address[],uint256[])' $AUTH --json | ship_args)
echo "aqua.ship: $(send $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"
send $USDC "approve(address,uint256)" $VAULT $MAX >/dev/null
echo "buy $UNITS @ 3000: $(send $VAULT 'buy(uint256,uint256,uint256,uint256)' $AUTH 3000000000000000000000 $UNITS $MAX)"
TOKEN=$(call $VAULT 'optionTokens(uint256,uint256)(address)' $AUTH 3000000000000000000000)
echo "optionToken $TOKEN  balance $(call $TOKEN 'balanceOf(address)(uint256)' $ME)"

echo; echo "── spread vault: 3000/3200 call credit spread, netted escrow ──"
CAP=$(python3 -c "u=int('$UNITS'); print((2*u*200 + 3199)//3200)")   # 2 units of (K2-K1)/K2 WETH, ceil
SAUTH=$(call $SPREAD 'nextAuthId()(uint256)')
echo "openStructure (authId $SAUTH): $(send $SPREAD 'openStructure(uint8,uint256[4],uint256,uint256)' 0 '[0,0,3000000000000000000000,3200000000000000000000]' $EXPIRY $CAP)"
mapfile -t S < <(call $SPREAD 'getShipParams(uint256)(address,bytes,address[],uint256[])' $SAUTH --json | ship_args)
echo "aqua.ship: $(send $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"
send $USDC "approve(address,uint256)" $SPREAD $MAX >/dev/null
QUOTE=$(call $SPREAD 'quote(uint256,uint256)(uint256,uint256,uint256)' $SAUTH $UNITS)
echo "quote (premium, fee, escrow): $(echo "$QUOTE" | tr '\n' ' ')"
WETH_BEFORE=$(call $WETH 'balanceOf(address)(uint256)' $ME | cut -d' ' -f1)
echo "buy: $(send $SPREAD 'buy(uint256,uint256,uint256)' $SAUTH $UNITS $MAX)"
WETH_AFTER=$(call $WETH 'balanceOf(address)(uint256)' $ME | cut -d' ' -f1)
STOKEN=$(call $SPREAD 'spreadTokens(uint256)(address)' $SAUTH)
echo "spreadToken $STOKEN  balance $(call $STOKEN 'balanceOf(address)(uint256)' $ME)"
echo "WETH pulled from writer: $((WETH_BEFORE - WETH_AFTER)) wei  (naked short leg would lock $UNITS)"

echo; echo "USDC after: $(call $USDC 'balanceOf(address)(uint256)' $ME)"
