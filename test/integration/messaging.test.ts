import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { systemClock } from "../../src/wagering/clock";
import { Metrics } from "../../src/observability";
import { WagerConsumer } from "../../src/messaging/consumer";
import { OutboxPublisher } from "../../src/messaging/publisher";
import { SqsGateway } from "../../src/messaging/sqs";
import { PendingReferenceWorker } from "../../src/messaging/worker";
import { PostgresWageringStore } from "../../src/persistence/store";
import { ResumePending } from "../../src/wagering/resume";
import { SubmitWager } from "../../src/wagering/submit";
import { TransientStoreError, type WageringStore, type WalletSession } from "../../src/wagering/store";
import { WagerTransactionStatus } from "../../src/wagering/transaction";
import { deferred, waitFor } from "../helpers/async";
import { expectLedgersMatch, sql, testOrm } from "../helpers/database";
import { drainQueue, publishOpeningOutbox, receiveBodies, requested, testQueues } from "../helpers/infra";
import { openWallet } from "../helpers/wagering";

let orm: MikroORM;
let store: PostgresWageringStore;
let submit: SubmitWager;
let sqs: SqsGateway;
let eventsUrl: string;
let dlqUrl: string;
let metrics: Metrics;

beforeAll(async () => {
  orm = await testOrm();
  store = new PostgresWageringStore(orm);
  submit = new SubmitWager(store, systemClock);
  const setup = await testQueues();
  sqs = setup.sqs;
  eventsUrl = setup.queues.eventsQueueUrl;
  dlqUrl = setup.queues.wagerDlqUrl;
  metrics = new Metrics();
});

beforeEach(async () => {
  await sql(orm, "delete from outbox_messages where published_at is null");
  await drainQueue(sqs, eventsUrl, 500);
  await drainQueue(sqs, dlqUrl, 300);
}, 15_000);

afterAll(async () => {
  await expectLedgersMatch(orm);
  await orm.close();
});

class StoreOverride implements WageringStore {
  constructor(
    private readonly inner: WageringStore,
    private readonly inWalletOverride?: WageringStore["inWallet"],
  ) {}

  inWallet<T>(walletId: string, work: (session: WalletSession) => Promise<T>): Promise<T> {
    return (this.inWalletOverride ?? this.inner.inWallet.bind(this.inner))(walletId, work);
  }

  openWallet(...args: Parameters<WageringStore["openWallet"]>) {
    return this.inner.openWallet(...args);
  }

  findWallet(...args: Parameters<WageringStore["findWallet"]>) {
    return this.inner.findWallet(...args);
  }

  findWager(...args: Parameters<WageringStore["findWager"]>) {
    return this.inner.findWager(...args);
  }

  findWagerByProviderExternal(...args: Parameters<WageringStore["findWagerByProviderExternal"]>) {
    return this.inner.findWagerByProviderExternal(...args);
  }

  ledgerPage(...args: Parameters<WageringStore["ledgerPage"]>) {
    return this.inner.ledgerPage(...args);
  }

  dueReferences(...args: Parameters<WageringStore["dueReferences"]>) {
    return this.inner.dueReferences(...args);
  }

  claimOutbox(...args: Parameters<WageringStore["claimOutbox"]>) {
    return this.inner.claimOutbox(...args);
  }

  oldestUnpublishedOutboxAt(...args: Parameters<WageringStore["oldestUnpublishedOutboxAt"]>) {
    return this.inner.oldestUnpublishedOutboxAt(...args);
  }

  ping(...args: Parameters<WageringStore["ping"]>) {
    return this.inner.ping(...args);
  }
}

function consumer(gateway = sqs, wagering: WageringStore = store): WagerConsumer {
  return new WagerConsumer(gateway, new SubmitWager(wagering, systemClock), metrics, systemClock, 2_000);
}

function publisher(gateway = sqs): OutboxPublisher {
  return new OutboxPublisher(store, gateway, metrics, systemClock, 60);
}

async function drain(target: WagerConsumer, groupId: string, body: string): Promise<void> {
  await sqs.sendWager(body, groupId, Bun.randomUUIDv7());
  target.start();
  await waitFor(async () => {
    const found = await store.findWagerByProviderExternal("provider-a", JSON.parse(body).data.externalTransactionId);
    return found ? true : undefined;
  });
  await target.stop();
}

describe("WagerConsumer", () => {
  test("applies a wager once, acks after commit, and publishes the outbox", async () => {
    const wallet = await openWallet(store, systemClock);
    await publishOpeningOutbox(sqs, eventsUrl, () => publisher().publishDue());
    const body = requested(wallet);
    const target = consumer();
    await drain(target, wallet.id, body);
    await publisher().publishDue();

    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("75.00");
    expect(await receiveBodies(sqs, eventsUrl, 2)).toBeArrayOfSize(2);
  });

  test("the same body messageId collapses in the inbox", async () => {
    const wallet = await openWallet(store, systemClock);
    const messageId = Bun.randomUUIDv7();
    const body = requested(wallet, { money: { amount: "10.00", currency: "BRL" } }, messageId);
    const target = consumer();

    await drain(target, wallet.id, body);
    await sqs.sendWager(body, wallet.id, Bun.randomUUIDv7());
    target.start();
    await Bun.sleep(1500);
    await target.stop();

    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("90.00");
  });

  test("the same messageId with another body is acknowledged and changes nothing", async () => {
    const wallet = await openWallet(store, systemClock);
    const messageId = Bun.randomUUIDv7();
    const first = requested(wallet, { money: { amount: "10.00", currency: "BRL" } }, messageId);
    const second = requested(wallet, { money: { amount: "11.00", currency: "BRL" } }, messageId);
    const target = consumer();

    await drain(target, wallet.id, first);
    await sqs.sendWager(second, wallet.id, Bun.randomUUIDv7());
    target.start();
    await Bun.sleep(1500);
    await target.stop();

    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("90.00");
  });

  test("an unparsable body, OPENING, and a missing key go to the DLQ", async () => {
    const wallet = await openWallet(store, systemClock);
    const target = consumer();
    target.start();

    await sqs.sendWager("{", wallet.id, Bun.randomUUIDv7());
    await sqs.sendWager(requested(wallet, { kind: "OPENING" }), wallet.id, Bun.randomUUIDv7());
    await sqs.sendWager(requested(wallet, { idempotencyKey: undefined }), wallet.id, Bun.randomUUIDv7());

    await waitFor(async () => ((await receiveBodies(sqs, dlqUrl, 3, 15_000)).length >= 3 ? true : undefined));
    await target.stop();
  });

  test("a transient error leaves the message and redrive sends it to the DLQ", async () => {
    const wallet = await openWallet(store, systemClock);
    const failing = new StoreOverride(store, async () => {
      throw new TransientStoreError("unavailable");
    });
    const target = consumer(sqs, failing);
    await sqs.sendWager(requested(wallet), wallet.id, Bun.randomUUIDv7());
    target.start();
    await waitFor(async () => ((await receiveBodies(sqs, dlqUrl, 1, 40_000)).length >= 1 ? true : undefined), 40_000);
    await target.stop();
  });

  test("a crash before ack redelivers and the inbox keeps one debit", async () => {
    const wallet = await openWallet(store, systemClock);
    const crashing = new Proxy(sqs, {
      get(target, property, receiver) {
        if (property === "delete") return async () => {
          throw new Error("crash before ack");
        };
        return Reflect.get(target, property, receiver);
      },
    }) as SqsGateway;

    const first = consumer(crashing);
    await sqs.sendWager(requested(wallet, { money: { amount: "10.00", currency: "BRL" } }), wallet.id, Bun.randomUUIDv7());
    first.start();
    await waitFor(async () => ((await store.findWallet(wallet.id))?.balance.toJSON().amount === "90.00" ? true : undefined));
    await first.stop();

    const second = consumer();
    second.start();
    await Bun.sleep(2000);
    await second.stop();

    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("90.00");
  });

  test("stop releases in-flight messages", async () => {
    const wallet = await openWallet(store, systemClock);
    const held = deferred();
    const blocking = new StoreOverride(store, async (walletId, work) => {
      held.resolve();
      await Bun.sleep(30_000);
      return store.inWallet(walletId, work);
    });
    const target = consumer(sqs, blocking);
    await sqs.sendWager(requested(wallet), wallet.id, Bun.randomUUIDv7());
    target.start();
    await held.promise;
    await target.stop();

    const returned = await sqs.receive();
    expect(returned.length).toBeGreaterThan(0);
  });
});

describe("OutboxPublisher", () => {
  test("two publishers never claim the same row, and a throw after send republishes the same eventId", async () => {
    const wallet = await openWallet(store, systemClock);
    await publishOpeningOutbox(sqs, eventsUrl, () => publisher().publishDue());
    const target = consumer();
    await drain(target, wallet.id, requested(wallet, { money: { amount: "1.00", currency: "BRL" } }));

    const once = new Proxy(sqs, {
      get(target, property, receiver) {
        if (property === "publishEvent") {
          return async (message: Parameters<SqsGateway["publishEvent"]>[0]) => {
            await Reflect.get(target, property, receiver).call(target, message);
            if (message.attempts === 0) throw new Error("crash after send");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SqsGateway;

    await publisher(once).publishDue();
    await Bun.sleep(1_100);
    await publisher().publishDue();
    await publisher().publishDue();

    const bodies = await receiveBodies(sqs, eventsUrl, 4);
    const ids = bodies.map((body) => JSON.parse(body).eventId as string);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });
});

describe("PendingReferenceWorker", () => {
  test("resumes a REFUND after its BET arrives", async () => {
    const wallet = await openWallet(store, systemClock);
    const bet = requested(wallet, { money: { amount: "10.00", currency: "BRL" } });
    const betId = JSON.parse(bet).data.externalTransactionId as string;
    const refund = requested(wallet, {
      kind: "REFUND",
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: betId,
    });
    const worker = new PendingReferenceWorker(store, new ResumePending(store, systemClock), metrics, systemClock);
    const target = consumer();

    await drain(target, wallet.id, refund);
    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("100.00");

    await drain(target, wallet.id, bet);
    await waitFor(async () => {
      await worker.resumeDue();
      return (await store.findWallet(wallet.id))?.balance.toJSON().amount === "100.00" ? true : undefined;
    });

    expect((await store.findWallet(wallet.id))?.balance.toJSON().amount).toBe("100.00");
    const stored = await store.findWagerByProviderExternal("provider-a", JSON.parse(refund).data.externalTransactionId);
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
  });
});
