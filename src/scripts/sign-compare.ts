/**
 * Sign an order with fixed parameters to compare with C++ implementation
 */
import { Wallet } from "@ethersproject/wallet";
import { ExchangeOrderBuilder } from "@polymarket/order-utils";
import { ClobClient, Side } from "@polymarket/clob-client";

const privateKey = process.env.PRIVATE_KEY!;
const funderAddress = process.env.FUNDER_ADDRESS!;

const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const CHAIN_ID = 137;

// Fixed test parameters - use exact same values as C++ live order
const FIXED_SALT = "898511237579";
const FIXED_TOKEN_ID = "92563197819715379987331460687172281109911655358298015247862860133160468784251";
const FIXED_MAKER_AMOUNT = "1000000";
const FIXED_TAKER_AMOUNT = "1010100";

async function main() {
  const wallet = new Wallet(privateKey);
  console.log("Signer address:", wallet.address);
  console.log("Funder address:", funderAddress);
  console.log("");

  // Create order builder with fixed salt generator
  const builder = new ExchangeOrderBuilder(
    NEG_RISK_CTF_EXCHANGE,
    CHAIN_ID,
    wallet,
    () => FIXED_SALT // Fixed salt for comparison
  );

  const orderData = {
    maker: funderAddress,
    signer: wallet.address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: FIXED_TOKEN_ID,
    makerAmount: FIXED_MAKER_AMOUNT,
    takerAmount: FIXED_TAKER_AMOUNT,
    side: 0, // BUY
    feeRateBps: "0",
    nonce: "0",
    expiration: "0",
    signatureType: 2, // POLY_GNOSIS_SAFE
  };

  console.log("=== ORDER DATA ===");
  console.log(JSON.stringify(orderData, null, 2));
  console.log("");

  const signedOrder = await builder.buildSignedOrder(orderData as any);

  console.log("=== SIGNED ORDER ===");
  console.log("salt:", signedOrder.salt);
  console.log("maker:", signedOrder.maker);
  console.log("signer:", signedOrder.signer);
  console.log("taker:", signedOrder.taker);
  console.log("tokenId:", signedOrder.tokenId);
  console.log("makerAmount:", signedOrder.makerAmount);
  console.log("takerAmount:", signedOrder.takerAmount);
  console.log("expiration:", signedOrder.expiration);
  console.log("nonce:", signedOrder.nonce);
  console.log("feeRateBps:", signedOrder.feeRateBps);
  console.log("side:", signedOrder.side);
  console.log("signatureType:", signedOrder.signatureType);
  console.log("signature:", signedOrder.signature);

  // Now try to post this order using the clob client
  console.log("\n=== POSTING ORDER ===");

  const tempClient = new ClobClient("https://clob.polymarket.com", CHAIN_ID, wallet);
  const creds = await tempClient.createOrDeriveApiKey();

  const client = new ClobClient(
    "https://clob.polymarket.com",
    CHAIN_ID,
    wallet,
    creds,
    2, // POLY_GNOSIS_SAFE
    funderAddress
  );

  try {
    const result = await client.postOrder(signedOrder as any, "FAK" as any);
    console.log("Post result:", JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log("Post error:", err?.response?.data || err?.message);
  }

  // Now try using createMarketOrder to see what it produces
  console.log("\n=== USING createMarketOrder ===");

  try {
    // Use createMarketOrder to see what it produces
    const marketOrder = await client.createMarketOrder(
      {
        tokenID: FIXED_TOKEN_ID,
        price: 0.99,
        amount: 1,
        side: Side.BUY,
      },
      { negRisk: true }
    );

    console.log("createMarketOrder result:");
    console.log("salt:", marketOrder.salt);
    console.log("maker:", marketOrder.maker);
    console.log("signer:", marketOrder.signer);
    console.log("tokenId:", marketOrder.tokenId);
    console.log("makerAmount:", marketOrder.makerAmount);
    console.log("takerAmount:", marketOrder.takerAmount);
    console.log("feeRateBps:", marketOrder.feeRateBps);
    console.log("signatureType:", marketOrder.signatureType);
    console.log("signature:", marketOrder.signature);

    // Post it
    const result = await client.postOrder(marketOrder, "FAK" as any);
    console.log("\nPost result:", JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log("Error:", err?.response?.data || err?.message);
  }
}

main().catch(console.error);
