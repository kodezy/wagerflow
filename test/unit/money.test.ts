import { describe, expect, test } from "bun:test";

import { CurrencyMismatchError, InvalidMoneyError } from "../../src/wagering/errors";
import { Money } from "../../src/wagering/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money", () => {
  test("reads and writes scale-2 decimal strings", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(Money.zero("BRL").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });

  test("adds and subtracts without rounding", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.01")).toJSON().amount).toBe("19.99");
    expect(brl("99999999999999999.99").subtract(brl("0.01")).toJSON().amount).toBe("99999999999999999.98");
  });

  test("returns new instances", () => {
    const original = brl("10.00");
    const sum = original.add(brl("5.00"));

    expect(original.toJSON().amount).toBe("10.00");
    expect(sum.toJSON().amount).toBe("15.00");
    expect(sum).not.toBe(original);
  });

  test("negates and compares", () => {
    expect(brl("25.00").negate().toJSON().amount).toBe("-25.00");
    expect(brl("25.00").negate().isNegative()).toBe(true);
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(usd("1.00"))).toBe(false);
  });

  test.each([
    "",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "1.5e2",
    "-1.00",
    "+1.00",
    "1",
    "1.0",
    "1.005",
    "01.00",
    " 1.00",
    "1.00 ",
    "100000000000000000.00",
  ])("rejects amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "B1L"])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });

  test("rejects values that are not strings", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test("throws on cross-currency arithmetic", () => {
    expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
});
