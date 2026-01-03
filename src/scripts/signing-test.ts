/**
 * Test script to verify order signing matches C++ implementation.
 * Run with: bun run src/scripts/signing-test.ts
 */

import { Wallet } from "ethers";
import { ExchangeOrderBuilder, SignatureType, Side } from "@polymarket/order-utils";

// Use same test private key as C++ test
const TEST_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Polymarket contract addresses (Polygon mainnet)
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const CHAIN_ID = 137;

async function main() {
  console.log("=== Order Signing Verification Test ===\n");

  // Create wallet from test private key
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  console.log("Private Key:", TEST_PRIVATE_KEY);
  console.log("Derived Address:", wallet.address);
  console.log();

  // Create order builder
  const builder = new ExchangeOrderBuilder(NEG_RISK_CTF_EXCHANGE, CHAIN_ID, wallet);

  // Test order parameters - use FIXED values for deterministic comparison
  // These match what C++ test uses
  const orderData = {
    maker: wallet.address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: "1234567890",
    makerAmount: "5000000", // 5 USDC (6 decimals)
    takerAmount: "10000000", // 10 shares
    side: Side.BUY,
    feeRateBps: "0",
    nonce: "0",
    signer: wallet.address,
    expiration: "0",
    signatureType: SignatureType.EOA,
  };

  console.log("Order Data (input):");
  console.log(JSON.stringify(orderData, null, 2));
  console.log();

  try {
    // Sign the order
    const signedOrder = await builder.buildSignedOrder(orderData);

    console.log("Signed Order (TypeScript output):");
    console.log(JSON.stringify(signedOrder, null, 2));
    console.log();

    // Key fields for C++ comparison
    console.log("=== Key Fields for C++ Comparison ===");
    console.log("salt:", signedOrder.salt);
    console.log("maker:", signedOrder.maker);
    console.log("signer:", signedOrder.signer);
    console.log("tokenId:", signedOrder.tokenId);
    console.log("makerAmount:", signedOrder.makerAmount);
    console.log("takerAmount:", signedOrder.takerAmount);
    console.log("side:", signedOrder.side);
    console.log("signatureType:", signedOrder.signatureType);
    console.log("signature:", signedOrder.signature);
    console.log();

    // Now test with a FIXED salt so we can compare signatures
    console.log("=== Testing with FIXED salt for signature comparison ===");
    const fixedSalt = "1234567890123456789012345678901234567890123456789012345678901234";

    const orderDataWithSalt = {
      ...orderData,
      salt: fixedSalt,
    };

    console.log("Fixed salt:", fixedSalt);
    const signedOrderFixed = await builder.buildSignedOrder(orderDataWithSalt);
    console.log("Signature with fixed salt:", signedOrderFixed.signature);
  } catch (error) {
    console.error("Error creating order:", error);
  }
}

main().catch(console.error);
