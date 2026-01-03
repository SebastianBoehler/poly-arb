/**
 * Redeem Positions Script
 *
 * Fetches positions from Data API and redeems winning shares via CTF contract.
 * Supports both EOA and Safe wallet redemption.
 *
 * Usage:
 *   bun run src/scripts/redeem-positions.ts [--dry-run] [--live]
 */

import { ethers, constants, BigNumber } from "ethers";
import "dotenv/config";

const DATA_API = "https://data-api.polymarket.com";
const POLYGON_RPC = "https://polygon-rpc.com";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEG_RISK_ADAPTER = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external",
];

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

enum OperationType {
  Call = 0,
  DelegateCall = 1,
}

interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: OperationType;
}

function joinHexData(hexData: string[]): string {
  return `0x${hexData
    .map((hex) => {
      const stripped = hex.replace(/^0x/, "");
      return stripped.length % 2 === 0 ? stripped : "0" + stripped;
    })
    .join("")}`;
}

function abiEncodePacked(...params: { type: string; value: any }[]): string {
  return joinHexData(
    params.map(({ type, value }) => {
      const encoded = ethers.utils.defaultAbiCoder.encode([type], [value]);

      if (type === "bytes" || type === "string") {
        const bytesLength = parseInt(encoded.slice(66, 130), 16);
        return encoded.slice(130, 130 + 2 * bytesLength);
      }

      const typeMatch = type.match(/^u?int(\d*)$/);
      if (typeMatch) {
        if (typeMatch[1] !== "") {
          const bytesLength = parseInt(typeMatch[1]) / 8;
          return encoded.slice(-2 * bytesLength);
        }
        return encoded.slice(-64);
      }

      if (type === "address") {
        return encoded.slice(-40);
      }

      throw new Error(`unsupported type ${type}`);
    })
  );
}

async function signTransactionHash(signer: ethers.Wallet, message: string) {
  const messageArray = ethers.utils.arrayify(message);
  let sig = await signer.signMessage(messageArray);
  let sigV = parseInt(sig.slice(-2), 16);

  switch (sigV) {
    case 0:
    case 1:
      sigV += 31;
      break;
    case 27:
    case 28:
      sigV += 4;
      break;
    default:
      throw new Error("Invalid signature");
  }

  sig = sig.slice(0, -2) + sigV.toString(16);

  return {
    r: BigNumber.from("0x" + sig.slice(2, 66)).toString(),
    s: BigNumber.from("0x" + sig.slice(66, 130)).toString(),
    v: BigNumber.from("0x" + sig.slice(130, 132)).toString(),
  };
}

async function signAndExecuteSafeTransaction(
  signer: ethers.Wallet,
  safe: ethers.Contract,
  txn: SafeTransaction,
  overrides?: ethers.Overrides
): Promise<ethers.providers.TransactionResponse> {
  if (overrides == null) {
    overrides = {};
  }

  const nonce = await safe.nonce();
  const safeTxGas = "0";
  const baseGas = "0";
  const gasPrice = "0";
  const gasToken = ethers.constants.AddressZero;
  const refundReceiver = ethers.constants.AddressZero;

  const txHash = await safe.getTransactionHash(txn.to, txn.value, txn.data, txn.operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);

  const rsvSignature = await signTransactionHash(signer, txHash);
  const packedSig = abiEncodePacked(
    { type: "uint256", value: rsvSignature.r },
    { type: "uint256", value: rsvSignature.s },
    { type: "uint8", value: rsvSignature.v }
  );

  return safe.execTransaction(txn.to, txn.value, txn.data, txn.operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, packedSig, overrides);
}

function encodeRedeem(collateralToken: string, conditionId: string): string {
  const iface = new ethers.utils.Interface(CTF_ABI);
  return iface.encodeFunctionData("redeemPositions", [collateralToken, ethers.constants.HashZero, conditionId, [1, 2]]);
}

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  outcome: string;
  outcomeIndex: number;
  negativeRisk: boolean;
}

async function fetchPositions(userAddress: string): Promise<Position[]> {
  const url = `${DATA_API}/positions?user=${userAddress}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch positions: ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--live");

  const privateKey = process.env.PRIVATE_KEY;
  const funderAddress = process.env.FUNDER_ADDRESS;

  if (!privateKey) {
    console.error("Error: PRIVATE_KEY environment variable required");
    process.exit(1);
  }

  console.log("Position Redemption Script");
  console.log("==========================\n");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"}\n`);

  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const userAddress = funderAddress || wallet.address;

  // Determine if using Safe wallet
  const useSafe = funderAddress && funderAddress.toLowerCase() !== wallet.address.toLowerCase();

  console.log(`[1] Wallet Info`);
  console.log(`    Signer:  ${wallet.address}`);
  console.log(`    User:    ${userAddress}`);
  console.log(`    Mode:    ${useSafe ? "Safe Wallet" : "EOA"}\n`);

  // Create Safe contract if needed
  let safe: ethers.Contract | null = null;
  if (useSafe) {
    safe = new ethers.Contract(funderAddress!, SAFE_ABI, wallet);
  }

  console.log(`[2] Fetching positions...`);
  const positions = await fetchPositions(userAddress);

  if (positions.length === 0) {
    console.log("    No positions found.\n");
    console.log("[DONE] No positions to process.");
    return;
  }

  console.log(`    Found ${positions.length} position(s)\n`);

  console.log(`[3] Position Details:`);
  console.log("-".repeat(80));

  let redeemableCount = 0;
  let mergeableCount = 0;
  let totalValue = 0;
  let totalPnl = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    console.log(`    [${i + 1}] ${pos.title}`);
    console.log(`        Outcome:     ${pos.outcome}`);
    console.log(`        Size:        ${pos.size.toFixed(4)} shares`);
    console.log(`        Avg Price:   $${pos.avgPrice.toFixed(4)}`);
    console.log(`        Cur Price:   $${pos.curPrice.toFixed(4)}`);
    console.log(`        Value:       $${pos.currentValue.toFixed(2)}`);
    console.log(`        PnL:         $${pos.cashPnl.toFixed(2)} (${pos.percentPnl.toFixed(1)}%)`);
    console.log(`        Redeemable:  ${pos.redeemable ? "YES" : "no"}`);
    console.log(`        Mergeable:   ${pos.mergeable ? "YES" : "no"}`);
    console.log(`        Neg Risk:    ${pos.negativeRisk ? "yes" : "no"}`);
    console.log(`        Condition:   ${pos.conditionId.substring(0, 22)}...`);
    console.log();

    if (pos.redeemable) redeemableCount++;
    if (pos.mergeable) mergeableCount++;
    totalValue += pos.currentValue;
    totalPnl += pos.cashPnl;
  }

  console.log("-".repeat(80));
  console.log(`    Summary:`);
  console.log(`        Total Positions: ${positions.length}`);
  console.log(`        Total Value:     $${totalValue.toFixed(2)}`);
  console.log(`        Total PnL:       $${totalPnl.toFixed(2)}`);
  console.log(`        Redeemable:      ${redeemableCount}`);
  console.log(`        Mergeable:       ${mergeableCount}\n`);

  // Process redeemable positions
  const redeemable = positions.filter((p) => p.redeemable);

  if (redeemable.length > 0) {
    console.log(`[4] Redeemable Positions:`);

    // Group by condition_id
    const byCondition = new Map<string, Position[]>();
    for (const pos of redeemable) {
      const existing = byCondition.get(pos.conditionId) || [];
      existing.push(pos);
      byCondition.set(pos.conditionId, existing);
    }

    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const negRiskCtf = new ethers.Contract(NEG_RISK_ADAPTER, CTF_ABI, wallet);

    for (const [conditionId, condPositions] of byCondition) {
      const pos = condPositions[0];
      const isNegRisk = pos.negativeRisk;
      const contract = isNegRisk ? negRiskCtf : ctf;
      const contractName = isNegRisk ? "NegRiskAdapter" : "CTF";

      console.log(`    Market: ${pos.title}`);
      console.log(`      Condition: ${conditionId}`);
      console.log(`      Contract:  ${contractName}`);

      const totalShares = condPositions.reduce((sum, p) => sum + p.size, 0);
      console.log(`      Shares:    ${totalShares.toFixed(4)}`);

      if (!dryRun) {
        console.log(`      Redeeming...`);
        try {
          const targetContract = isNegRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS;
          const data = encodeRedeem(USDC_ADDRESS, conditionId);

          let tx: ethers.providers.TransactionResponse;

          if (useSafe && safe) {
            // Use Safe wallet transaction
            const safeTxn: SafeTransaction = {
              to: targetContract,
              data: data,
              operation: OperationType.Call,
              value: "0",
            };
            // Get current gas price from network
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice?.mul(120).div(100); // Add 20% buffer
            tx = await signAndExecuteSafeTransaction(wallet, safe, safeTxn, { gasPrice, gasLimit: 500000 });
          } else {
            // Direct EOA transaction
            const parentCollectionId = constants.HashZero;
            const indexSets = [1, 2];
            tx = await contract.redeemPositions(USDC_ADDRESS, parentCollectionId, conditionId, indexSets);
          }

          console.log(`      TX Hash: ${tx.hash}`);
          console.log(`      Waiting for confirmation...`);

          const receipt = await tx.wait();
          console.log(`      ✓ Confirmed in block ${receipt.blockNumber}`);
          console.log(`      Gas used: ${receipt.gasUsed.toString()}`);
        } catch (error: any) {
          console.log(`      ✗ Failed: ${error.message}`);
        }
      } else {
        console.log(`      [DRY RUN] Would redeem ${totalShares.toFixed(4)} shares via ${useSafe ? "Safe" : "EOA"}`);
      }
      console.log();
    }
  } else {
    console.log(`[4] No redeemable positions found.\n`);
  }

  // Process mergeable positions
  const mergeable = positions.filter((p) => p.mergeable);

  if (mergeable.length > 0) {
    console.log(`[5] Mergeable Positions:`);

    // Group by condition_id
    const byCondition = new Map<string, Position[]>();
    for (const pos of mergeable) {
      const existing = byCondition.get(pos.conditionId) || [];
      existing.push(pos);
      byCondition.set(pos.conditionId, existing);
    }

    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const negRiskCtf = new ethers.Contract(NEG_RISK_ADAPTER, CTF_ABI, wallet);

    for (const [conditionId, condPositions] of byCondition) {
      const pos = condPositions[0];
      const isNegRisk = pos.negativeRisk;
      const contract = isNegRisk ? negRiskCtf : ctf;

      console.log(`    Market: ${pos.title}`);

      // Find Yes/No (or Up/Down) sizes
      let yesSize = 0;
      let noSize = 0;
      for (const p of condPositions) {
        const outcome = p.outcome.toLowerCase();
        if (outcome === "yes" || outcome === "up" || p.outcomeIndex === 0) {
          yesSize = p.size;
        } else if (outcome === "no" || outcome === "down" || p.outcomeIndex === 1) {
          noSize = p.size;
        }
      }

      const mergeAmount = Math.min(yesSize, noSize);
      console.log(`      Yes: ${yesSize.toFixed(4)}, No: ${noSize.toFixed(4)}`);
      console.log(`      Can merge: ${mergeAmount.toFixed(4)} shares -> $${mergeAmount.toFixed(2)} USDC`);

      if (!dryRun && mergeAmount > 0) {
        console.log(`      Merging...`);
        try {
          const parentCollectionId = constants.HashZero;
          const partition = [1n, 2n];
          const amountWei = BigInt(Math.floor(mergeAmount * 1e6)); // USDC has 6 decimals

          const tx = await contract.mergePositions(USDC_ADDRESS, parentCollectionId, conditionId, partition, amountWei);

          console.log(`      TX Hash: ${tx.hash}`);
          console.log(`      Waiting for confirmation...`);

          const receipt = await tx.wait();
          console.log(`      ✓ Confirmed in block ${receipt.blockNumber}`);
        } catch (error: any) {
          console.log(`      ✗ Failed: ${error.message}`);
        }
      } else if (mergeAmount > 0) {
        console.log(`      [DRY RUN] Would merge ${mergeAmount.toFixed(4)} shares`);
      }
      console.log();
    }
  } else {
    console.log(`[5] No mergeable positions found.\n`);
  }

  if (dryRun && (redeemableCount > 0 || mergeableCount > 0)) {
    console.log(`[NOTE] Use --live flag to actually execute transactions.\n`);
  }

  console.log("[DONE] Position redemption script complete.");
}

main().catch(console.error);
