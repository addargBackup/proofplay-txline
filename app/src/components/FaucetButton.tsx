"use client";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { postJson } from "@/lib/client";

export function FaucetButton() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!wallet.publicKey) return null;
  return (
    <button
      className="btn-outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await postJson("/api/faucet", { wallet: wallet.publicKey!.toBase58() });
          setDone(true);
          setTimeout(() => setDone(false), 4000);
        } catch (e) {
          alert(String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "sending…" : done ? "+500 pUSDC ✓" : "Get pUSDC"}
    </button>
  );
}
