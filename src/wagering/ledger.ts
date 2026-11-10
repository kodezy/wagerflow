import { UnbalancedLedgerError } from "./errors";
import type { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);

    if (!props.money.isPositive()) throw new UnbalancedLedgerError("ledger money must be positive");
    if (props.balanceAfter.isNegative()) throw new UnbalancedLedgerError("ledger balance after is negative");
    if (!entry.isBalanced()) throw new UnbalancedLedgerError("balance before ± money differs from balance after");

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedMoney()).equals(this.balanceAfter);
  }

  signedMoney(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  toState(): LedgerEntryState {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
      createdAt: this.createdAt,
    };
  }
}
