#!/usr/bin/env bash
# MarginVault + RfqVault on Arc testnet with Circle's REAL USDC, as plain
# `cast send` transactions (forge's local simulation cannot execute Arc's
# native-asset USDC — see arc-smoke.sh):
#   seed the backstop pool and insurance fund in USDC → writer ships a
#   margined put range → a 0.01-unit ATM put fills pulling only initial
#   margin (15 USDC, not the 30 USDC strike) → LP signs an RFQ quote inside
#   the formula Ask → the taker fills it, WETH pulled JIT.
#
#   PRIVATE_KEY=0x… ./script/arc-siblings-smoke.sh
# Env: PRIVATE_KEY (deployer = LP = taker), optional RPC, UNITS (WAD, default
# 1e16), addresses (defaults from the latest DeployArcSiblings broadcast and
# docs/arc-testnet-deployment.md).
set -euo pipefail

RPC=${RPC:-https://rpc.testnet.arc.network}
CHAIN_ID=${CHAIN_ID:-5042002}
UNITS=${UNITS:-10000000000000000}
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
: "${PRIVATE_KEY:?set PRIVATE_KEY}"
ME=$(cast wallet address --private-key "$PRIVATE_KEY")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BROADCAST="$ROOT/broadcast/DeployArcSiblings.s.sol/$CHAIN_ID/run-latest.json"
addr_of() { python3 -c "
import json
d=json.load(open('$BROADCAST'))
for tx in d['transactions']:
    if tx.get('contractName')=='$1': print(tx['contractAddress'])
" | ${2:-head} -1; }
MV=${MV:-$(addr_of MarginVault)}
BACKSTOP=${BACKSTOP:-$(addr_of MarginBackstop)}
RFQ=${RFQ:-$(addr_of RfqVault)}
AQUA=${AQUA:-0x641970C7D4534d983Aa7BB9E2c7700ea3007bb7d}
WETH=${WETH:-0x9A963e6D53b70C2a6F0F90C0E98877a97B9e0abe}
USDC=${USDC:-0x3600000000000000000000000000000000000000}
ORACLE=${ORACLE:-0xd525D62124874B690942cfEef78fdC44AD08Eaf4}   # mock ETH/USD feed (no Chainlink on Arc testnet)
K=3000000000000000000000

send() { cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json "$@" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["transactionHash"], "status", d["status"])'; }
call() { cast call --rpc-url "$RPC" "$@"; }
num() { cut -d' ' -f1; }
usdc() { python3 -c "print(f'{int(\"$1\")/1e6:,.6f} USDC')"; }
ship_args() { python3 -c '
import json,sys
app,strategy,tokens,amounts=json.load(sys.stdin)
print(app); print(strategy); print("["+",".join(tokens)+"]"); print("["+",".join(str(int(a)) for a in amounts)+"]")'; }

echo "deployer $ME  margin $MV  backstop $BACKSTOP  rfq $RFQ"
echo "USDC before: $(usdc $(call $USDC 'balanceOf(address)(uint256)' $ME | num))"
EXPIRY=$(( $(date +%s) + 30*86400 ))

echo; echo "── fresh oracle round: the mock feed's last answer is hours old and both vaults refuse stale marks ──"
echo "oracle.setAnswer(3000): $(send $ORACLE 'setAnswer(int256)' 300000000000)"

echo; echo "── seed: 15 USDC into the backstop pool, 2 USDC into insurance (real USDC) ──"
if [ "$(call $BACKSTOP 'totalAssets()(uint256)' | num)" -lt 15000000 ]; then
  send $USDC "approve(address,uint256)" $BACKSTOP $MAX >/dev/null
  echo "backstop.deposit: $(send $BACKSTOP 'deposit(uint256)' 15000000)"
  send $USDC "approve(address,uint256)" $MV $MAX >/dev/null
  echo "fundInsurance:    $(send $MV 'fundInsurance(uint256)' 2000000)"
else
  echo "already seeded: backstop $(usdc $(call $BACKSTOP 'totalAssets()(uint256)' | num))  insurance $(usdc $(call $MV 'insuranceFund()(uint256)' | num))"
fi
echo "ceiling now $(usdc $(call $MV 'effectiveCeiling()(uint256)' | num)) (7 x backstop)"

echo; echo "── margined put: 2500–3500 range, 20 USDC margin capacity, 0.01-unit ATM fill ──"
send $USDC "approve(address,uint256)" $AQUA $MAX >/dev/null
MAUTH=$(call $MV 'nextAuthId()(uint256)' | num)
echo "openRange #$MAUTH: $(send $MV 'openRange(uint256,uint256,uint256,uint256,uint16,bool,uint16)' 2500000000000000000000 3500000000000000000000 $EXPIRY 20000000 0 true 0)"
mapfile -t S < <(call $MV 'getShipParams(uint256)(address,bytes,address[],uint256[])' $MAUTH --json | ship_args)
echo "aqua.ship: $(send $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"
echo "initial margin for the fill: $(usdc $(call $MV 'initialMargin(uint256,uint256,uint256)(uint256)' $MAUTH $K $UNITS | num))  (cash-secured would be $(usdc $(python3 -c "print(3000*int('$UNITS')//10**12)")))"
echo "buy: $(send $MV 'buy(uint256,uint256,uint256,uint256)' $MAUTH $K $UNITS $MAX)"
SID=$(call $MV 'seriesId(uint256,uint256)(bytes32)' $K $EXPIRY)
echo "position locked: $(usdc $(call $MV 'positions(bytes32,address)(uint256,uint256,uint256,uint64,uint64,address)' $SID $ME | sed -n 3p | num))  naked notional $(usdc $(call $MV 'nakedNotional()(uint256)' | num))"

echo; echo "── RFQ: 2500–3500 call range, signed quote 100 bps inside the formula, filled ──"
send $WETH "approve(address,uint256)" $AQUA $MAX >/dev/null
RAUTH=$(call $RFQ 'nextAuthId()(uint256)' | num)
echo "openRange #$RAUTH: $(send $RFQ 'openRange(uint256,uint256,uint256,uint256,bool)' 2500000000000000000000 3500000000000000000000 $EXPIRY $UNITS true)"
mapfile -t S < <(call $RFQ 'getShipParams(uint256)(address,bytes,address[],uint256[])' $RAUTH --json | ship_args)
echo "aqua.ship: $(send $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"
FORMULA=$(call $RFQ 'formulaQuote(uint256,uint256,uint256)(uint256,uint256)' $RAUTH $K $UNITS | head -1 | num)
PPU=$(python3 -c "print(int('$FORMULA') * 9900 // 10000 * 10**18 // int('$UNITS'))")
TTL=$(( $(date +%s) + 900 )); NONCE=$(date +%s%N)
TYPED=$(python3 -c "
import json
print(json.dumps({'types': {'EIP712Domain':[{'name':'name','type':'string'},{'name':'version','type':'string'},{'name':'chainId','type':'uint256'},{'name':'verifyingContract','type':'address'}],
 'Quote':[{'name':'authId','type':'uint256'},{'name':'strike','type':'uint256'},{'name':'maxAmount','type':'uint256'},{'name':'premiumPerUnit','type':'uint256'},{'name':'ttl','type':'uint256'},{'name':'nonce','type':'uint256'}]},
 'primaryType':'Quote','domain': {'name':'Smile RFQ','version':'1','chainId': '$CHAIN_ID','verifyingContract':'$RFQ'},
 'message': {'authId': '$RAUTH','strike': '$K','maxAmount': '$UNITS','premiumPerUnit': '$PPU','ttl': '$TTL','nonce': '$NONCE'}}))")
SIG=$(cast wallet sign --private-key "$PRIVATE_KEY" --data "$TYPED")
Q="($RAUTH,$K,$UNITS,$PPU,$TTL,$NONCE)"
echo "formula Ask $(usdc $FORMULA)  signed quote $(usdc $(call $RFQ 'fillCost((uint256,uint256,uint256,uint256,uint256,uint256),uint256)(uint256,uint256)' "$Q" $UNITS | head -1 | num))"
send $USDC "approve(address,uint256)" $RFQ $MAX >/dev/null
W0=$(call $WETH 'balanceOf(address)(uint256)' $ME | num)
echo "fill: $(send $RFQ 'fill((uint256,uint256,uint256,uint256,uint256,uint256),bytes,uint256,uint256)' "$Q" "$SIG" $UNITS $MAX)"
W1=$(call $WETH 'balanceOf(address)(uint256)' $ME | num)
echo "WETH pulled JIT: $((W0 - W1)) wei  optionToken $(call $RFQ 'optionTokens(uint256,uint256)(address)' $RAUTH $K)"

echo; echo "USDC after: $(usdc $(call $USDC 'balanceOf(address)(uint256)' $ME | num))"
