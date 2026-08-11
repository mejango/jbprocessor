/**
 * Source of the beneficiary address for a payer who didn't bring their own
 * wallet. Task 8 supplies the Para-backed implementation
 * (`src/wallets/para.ts`); checkout only depends on this interface so the
 * web process can be tested -- and run -- without Para credentials.
 *
 * Implementations must be idempotent per email: calling twice for the same
 * address returns the same wallet, never a second one.
 */
export interface WalletProvider {
  getOrCreatePregenWallet(email: string): Promise<`0x${string}`>;
}
