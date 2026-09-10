import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  newMockEvent,
  createMockedFunction,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  RangeAuthorized,
  AuthorizationRevoked,
  OptionBought,
} from "../generated/AquaCollateralVault/AquaCollateralVault";
import { handleRangeAuthorized, handleAuthorizationRevoked, handleOptionBought } from "../src/vault";

const VAULT = Address.fromString("0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0");
const LP = Address.fromString("0x1111111111111111111111111111111111111111");
const BUYER = Address.fromString("0x2222222222222222222222222222222222222222");
const WETH = Address.fromString("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
const USDC = Address.fromString("0x5FbDB2315678afecb367f032d93F642f64180aa3");
const TOKEN = Address.fromString("0x3333333333333333333333333333333333333333");
const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000");

const AUTH_SIG =
  "authorizations(uint256):(address,uint256,uint256,uint256,uint256,uint256,address,bool,bool,address,address,uint8,bytes32,int256,uint16,uint32,address)";

function u(v: i32): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(v));
}

// The vault's `authorizations` getter, as the mapping's bound call sees it.
function mockAuthorizations(authId: BigInt, used: BigInt, active: boolean): void {
  createMockedFunction(VAULT, "authorizations", AUTH_SIG)
    .withArgs([ethereum.Value.fromUnsignedBigInt(authId)])
    .returns([
      ethereum.Value.fromAddress(LP),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromString("2800000000000000000000")),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromString("3200000000000000000000")),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1_800_000_000)),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromString("5000000000000000000")),
      ethereum.Value.fromUnsignedBigInt(used),
      ethereum.Value.fromAddress(WETH),
      ethereum.Value.fromBoolean(true),
      ethereum.Value.fromBoolean(active),
      ethereum.Value.fromAddress(USDC),
      ethereum.Value.fromAddress(Address.zero()),
      u(6),
      ethereum.Value.fromFixedBytes(ZERO32),
      ethereum.Value.fromSignedBigInt(BigInt.zero()),
      u(3600),
      u(10_000_000),
      ethereum.Value.fromAddress(LP),
    ]);
}

function rangeAuthorized(authId: i32): RangeAuthorized {
  let ev = changetype<RangeAuthorized>(newMockEvent());
  ev.address = VAULT;
  ev.parameters = [];
  ev.parameters.push(new ethereum.EventParam("authId", u(authId)));
  ev.parameters.push(new ethereum.EventParam("lp", ethereum.Value.fromAddress(LP)));
  ev.parameters.push(new ethereum.EventParam("strikeMin", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("2800000000000000000000"))));
  ev.parameters.push(new ethereum.EventParam("strikeMax", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("3200000000000000000000"))));
  ev.parameters.push(new ethereum.EventParam("expiry", u(1_800_000_000)));
  ev.parameters.push(new ethereum.EventParam("isCall", ethereum.Value.fromBoolean(true)));
  ev.parameters.push(new ethereum.EventParam("maxCollateral", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("5000000000000000000"))));
  return ev;
}

function authorizationRevoked(authId: i32): AuthorizationRevoked {
  let ev = changetype<AuthorizationRevoked>(newMockEvent());
  ev.address = VAULT;
  ev.parameters = [];
  ev.parameters.push(new ethereum.EventParam("authId", u(authId)));
  return ev;
}

function optionBought(authId: i32, amountWad: string, premium: i32): OptionBought {
  let ev = changetype<OptionBought>(newMockEvent());
  ev.address = VAULT;
  ev.parameters = [];
  ev.parameters.push(new ethereum.EventParam("authId", u(authId)));
  ev.parameters.push(new ethereum.EventParam("optionToken", ethereum.Value.fromAddress(TOKEN)));
  ev.parameters.push(new ethereum.EventParam("buyer", ethereum.Value.fromAddress(BUYER)));
  ev.parameters.push(new ethereum.EventParam("strike", ethereum.Value.fromUnsignedBigInt(BigInt.fromString("3000000000000000000000"))));
  ev.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amountWad))));
  ev.parameters.push(new ethereum.EventParam("premium", u(premium)));
  return ev;
}

describe("AquaCollateralVault mappings", () => {
  beforeEach(() => {
    clearStore();
  });

  test("handleRangeAuthorized creates an active Authorization, filling collateralToken via the bound call", () => {
    mockAuthorizations(BigInt.fromI32(0), BigInt.zero(), true);
    handleRangeAuthorized(rangeAuthorized(0));

    assert.entityCount("Authorization", 1);
    assert.fieldEquals("Authorization", "0", "lp", LP.toHexString());
    assert.fieldEquals("Authorization", "0", "strikeMin", "2800000000000000000000");
    assert.fieldEquals("Authorization", "0", "strikeMax", "3200000000000000000000");
    assert.fieldEquals("Authorization", "0", "isCall", "true");
    assert.fieldEquals("Authorization", "0", "active", "true");
    assert.fieldEquals("Authorization", "0", "usedCollateral", "0");
    assert.fieldEquals("Authorization", "0", "fillCount", "0");
    // Not on the event — proves the bound-call refresh ran.
    assert.fieldEquals("Authorization", "0", "collateralToken", WETH.toHexString());
  });

  test("handleAuthorizationRevoked flips active=false and leaves the rest untouched", () => {
    mockAuthorizations(BigInt.fromI32(0), BigInt.zero(), true);
    handleRangeAuthorized(rangeAuthorized(0));
    handleAuthorizationRevoked(authorizationRevoked(0));

    assert.fieldEquals("Authorization", "0", "active", "false");
    assert.fieldEquals("Authorization", "0", "strikeMin", "2800000000000000000000");
    assert.fieldEquals("Authorization", "0", "lp", LP.toHexString());
  });

  test("handleOptionBought records a Fill and refreshes usedCollateral from the contract, not from reimplemented math", () => {
    mockAuthorizations(BigInt.fromI32(0), BigInt.zero(), true);
    handleRangeAuthorized(rangeAuthorized(0));

    // After the fill the chain says 1 WETH is in use — the mapping must
    // take that number from the call, not compute it.
    mockAuthorizations(BigInt.fromI32(0), BigInt.fromString("1000000000000000000"), true);
    handleOptionBought(optionBought(0, "1000000000000000000", 698_989_842));

    assert.entityCount("Fill", 1);
    assert.fieldEquals("Authorization", "0", "fillCount", "1");
    assert.fieldEquals("Authorization", "0", "usedCollateral", "1000000000000000000");
  });

  test("an older authorization stays visible after a newer one appears — the LPDashboard bug this replaces", () => {
    mockAuthorizations(BigInt.fromI32(0), BigInt.zero(), true);
    handleRangeAuthorized(rangeAuthorized(0));
    mockAuthorizations(BigInt.fromI32(1), BigInt.zero(), true);
    handleRangeAuthorized(rangeAuthorized(1));

    assert.entityCount("Authorization", 2);
    assert.fieldEquals("Authorization", "0", "active", "true");
    assert.fieldEquals("Authorization", "1", "active", "true");
  });
});
