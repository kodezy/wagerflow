import { describe, expect, test } from "bun:test";

import { ValidationCode, ValidationError } from "../../src/wagering/errors";
import { canonicalHash, canonicalJson, sha256 } from "../../src/wagering/hash";
import { parseWagerRequest, parseWalletRequest } from "../../src/wagering/request";

const body = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ValidationError) return `${error.code}:${error.field}`;
    throw error;
  }

  return "valid";
}

describe("canonical JSON", () => {
  test("sorts keys at every level and drops null and undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: null }, e: undefined })).toBe('{"a":{"d":"x"},"b":1}');
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseWagerRequest", () => {
  test("parses the challenge example and hashes business fields only", () => {
    const request = parseWagerRequest(body, "provider-a:transaction-123");

    expect(request.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(request.idempotencyKey).toBe("provider-a:transaction-123");
    expect(request.payloadHash).toBe(canonicalHash(body));
    expect(parseWagerRequest(body, "another-key").payloadHash).toBe(request.payloadHash);
  });

  test("key order, extra fields, and a null reference do not change the hash", () => {
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const hash = parseWagerRequest(body, "k").payloadHash;

    expect(parseWagerRequest(reordered, "k").payloadHash).toBe(hash);
    expect(parseWagerRequest({ ...body, note: "ignored" }, "k").payloadHash).toBe(hash);
    expect(parseWagerRequest({ ...body, referenceExternalTransactionId: null }, "k").payloadHash).toBe(hash);
  });

  test("every business field changes the hash", () => {
    const hash = parseWagerRequest(body, "k").payloadHash;
    const changes = [
      { providerId: "provider-b" },
      { externalTransactionId: "transaction-124" },
      { playerId: "player-x" },
      { walletId: "wallet-x" },
      { roundId: "round-x" },
      { gameId: "game-x" },
      { kind: "LOSS" },
      { money: { amount: "25.01", currency: "BRL" } },
      { kind: "WIN", referenceExternalTransactionId: "transaction-100" },
    ];

    for (const change of changes) expect(parseWagerRequest({ ...body, ...change }, "k").payloadHash).not.toBe(hash);
  });

  test("validation codes", () => {
    expect(codeOf(() => parseWagerRequest(body, undefined))).toBe("IDEMPOTENCY_KEY_REQUIRED:idempotencyKey");
    expect(codeOf(() => parseWagerRequest(body, ""))).toBe("IDEMPOTENCY_KEY_REQUIRED:idempotencyKey");
    expect(codeOf(() => parseWagerRequest(body, "k".repeat(256)))).toBe("INVALID_PAYLOAD:idempotencyKey");
    expect(codeOf(() => parseWagerRequest("not an object", "k"))).toBe("INVALID_PAYLOAD:body");
    expect(codeOf(() => parseWagerRequest([body], "k"))).toBe("INVALID_PAYLOAD:body");
    expect(codeOf(() => parseWagerRequest({ ...body, roundId: "" }, "k"))).toBe("INVALID_PAYLOAD:roundId");
    expect(codeOf(() => parseWagerRequest({ ...body, gameId: 7 }, "k"))).toBe("INVALID_PAYLOAD:gameId");
    expect(codeOf(() => parseWagerRequest({ ...body, playerId: "p".repeat(256) }, "k"))).toBe("INVALID_PAYLOAD:playerId");
    expect(codeOf(() => parseWagerRequest({ ...body, kind: "JACKPOT" }, "k"))).toBe("INVALID_PAYLOAD:kind");
    expect(codeOf(() => parseWagerRequest({ ...body, kind: "OPENING" }, "k"))).toBe("OPENING_NOT_ACCEPTED:kind");
    expect(codeOf(() => parseWagerRequest({ ...body, money: { amount: 25, currency: "BRL" } }, "k"))).toBe("INVALID_MONEY:money");
    expect(codeOf(() => parseWagerRequest({ ...body, money: { amount: "1e2", currency: "BRL" } }, "k"))).toBe("INVALID_MONEY:money");
    expect(codeOf(() => parseWagerRequest({ ...body, money: "25.00" }, "k"))).toBe("INVALID_MONEY:money");
    expect(codeOf(() => parseWagerRequest({ ...body, money: { amount: "0.00", currency: "BRL" } }, "k"))).toBe("INVALID_MONEY:money");
    expect(codeOf(() => parseWagerRequest({ ...body, kind: "REFUND" }, "k"))).toBe("INVALID_PAYLOAD:referenceExternalTransactionId");
    expect(codeOf(() => parseWagerRequest({ ...body, referenceExternalTransactionId: "x" }, "k"))).toBe(
      "INVALID_PAYLOAD:referenceExternalTransactionId",
    );
    expect(codeOf(() => parseWagerRequest({ ...body, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }, "k"))).toBe("valid");
  });
});

describe("parseWalletRequest", () => {
  test("accepts zero and rejects bad input", () => {
    expect(parseWalletRequest({ playerId: "player-1", initialBalance: { amount: "0.00", currency: "BRL" } }).initialBalance.isZero()).toBe(true);
    expect(codeOf(() => parseWalletRequest({ playerId: "player-1", initialBalance: { amount: "-1.00", currency: "BRL" } }))).toBe(
      "INVALID_MONEY:initialBalance",
    );
    expect(codeOf(() => parseWalletRequest({ initialBalance: { amount: "1.00", currency: "BRL" } }))).toBe("INVALID_PAYLOAD:playerId");
    expect(codeOf(() => parseWalletRequest(null))).toBe(`${ValidationCode.InvalidPayload}:body`);
  });
});
