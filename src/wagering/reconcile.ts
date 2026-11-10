import { Money, type MoneyProps } from "./money";
import type { WageringStore } from "./store";

export interface Reconciliation {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(private readonly store: WageringStore) {}

  execute(walletId: string): Promise<Reconciliation | undefined> {
    return this.store.inWallet(walletId, async (session) => {
      const wallet = await session.lockWallet(walletId);
      if (!wallet) return undefined;

      const entries = await session.ledgerEntries(walletId);
      const calculated = entries.reduce((sum, entry) => sum.add(entry.signedMoney()), Money.zero(wallet.currency));
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries.length,
      };
    });
  }
}
