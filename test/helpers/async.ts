export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }

  throw new Error(`timed out waiting for ${label}`);
}
