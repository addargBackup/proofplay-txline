import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import Providers from "@/components/Providers";
import { WalletButton } from "@/components/WalletButton";
import { FaucetButton } from "@/components/FaucetButton";

export const metadata: Metadata = {
  title: "ProofPlay — markets settled by proof, not by us",
  description:
    "Permissionless parimutuel World Cup markets on Solana devnet, settled trustlessly by TxLINE Merkle proofs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="border-b border-line">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
              <div className="flex items-center gap-6">
                <Link href="/" className="text-lg font-bold tracking-tight">
                  ⚽ Proof<span className="text-grass">Play</span>
                </Link>
                <nav className="flex gap-4 text-sm text-neutral-300">
                  <Link href="/" className="hover:text-grass">Markets</Link>
                  <Link href="/create" className="hover:text-grass">Create a market</Link>
                </nav>
              </div>
              <div className="flex items-center gap-2">
                <FaucetButton />
                <WalletButton />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
          <footer className="mx-auto max-w-5xl px-4 pb-8 pt-4 text-xs text-neutral-500">
            Devnet demo — pUSDC is worthless test money. Markets settle only via TxLINE Merkle proofs
            verified on-chain by the txoracle program. Nobody (including us) can decide an outcome.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
