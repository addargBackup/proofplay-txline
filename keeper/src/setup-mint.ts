/** One-time: create the pUSDC demo mint (6 decimals) + fund the keeper's ATA.
 *  Devnet demo money only — the program is mint-agnostic. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAssociatedTokenAccountIdempotent, createMint, mintTo } from "@solana/spl-token";
import { connection, loadWallet, ROOT } from "./common.js";

const conn = connection();
const wallet = loadWallet();
const outFile = path.join(ROOT, ".keys", "pusdc-mint.json");

if (fs.existsSync(outFile)) {
  console.log("mint already recorded:", JSON.parse(fs.readFileSync(outFile, "utf8")).mint);
  process.exit(0);
}

const mint = await createMint(conn, wallet, wallet.publicKey, null, 6);
const ata = await createAssociatedTokenAccountIdempotent(conn, wallet, mint, wallet.publicKey);
await mintTo(conn, wallet, mint, ata, wallet, 1_000_000n * 1_000_000n); // 1M pUSDC

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ mint: mint.toBase58(), decimals: 6 }, null, 2));
console.log("pUSDC mint:", mint.toBase58());
console.log("keeper ATA:", ata.toBase58(), "(funded 1,000,000 pUSDC)");
