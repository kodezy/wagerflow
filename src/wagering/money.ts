import { Decimal } from "decimal.js";

import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props !== "object" || props === null) throw new InvalidMoneyError("amount");
    if (typeof props.amount !== "string" || !AMOUNT.test(props.amount)) throw new InvalidMoneyError("amount");
    if (typeof props.currency !== "string" || !CURRENCY.test(props.currency)) throw new InvalidMoneyError("currency");

    return new Money(new Exact(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY.test(currency)) throw new InvalidMoneyError("currency");

    return new Money(new Exact(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.format(), currency: this.currency };
  }

  toString(): string {
    return `${this.format()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private format(): string {
    return this.value.isZero() ? "0.00" : this.value.toFixed(2);
  }
}

const Exact = Decimal.clone({ precision: 40 });
const AMOUNT = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
