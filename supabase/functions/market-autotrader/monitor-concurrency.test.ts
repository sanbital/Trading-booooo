import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapConcurrentOrdered } from "./monitor-concurrency.ts";

Deno.test("position monitor bounds independent checks and preserves input order", async () => {
  const started: number[] = [];
  const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const thirdStarted = Promise.withResolvers<void>();

  const result = mapConcurrentOrdered([3, 1, 2], async (value, index) => {
    started.push(value);
    if (index === 2) thirdStarted.resolve();
    await releases[index].promise;
    return value * 10;
  });

  await Promise.resolve();
  assertEquals(started, [3, 1]);

  releases[0].resolve();
  await thirdStarted.promise;
  assertEquals(started, [3, 1, 2]);
  releases[2].resolve();
  releases[1].resolve();
  assertEquals(await result, [30, 10, 20]);
});

Deno.test("empty position batches complete without work", async () => {
  let calls = 0;
  const result = await mapConcurrentOrdered([], async () => {
    calls += 1;
    return "unexpected";
  });
  assertEquals(result, []);
  assertEquals(calls, 0);
});

Deno.test("position monitor never exceeds an explicit concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrentOrdered(
    [30, 5, 20, 10, 1],
    async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return `row-${index}`;
    },
    2,
  );
  assertEquals(peak, 2);
  assertEquals(result, ["row-0", "row-1", "row-2", "row-3", "row-4"]);
});
