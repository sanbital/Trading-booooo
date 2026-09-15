import { collectPages } from "./rest-pagination.ts";

Deno.test("collectPages reads beyond the PostgREST 1,000-row cap", async () => {
  const source = Array.from({ length: 2305 }, (_, index) => index);
  const ranges: Array<[number, number]> = [];
  const result = await collectPages(async (from, to) => {
    ranges.push([from, to]);
    return source.slice(from, to + 1);
  });

  if (result.length !== source.length) throw new Error(`expected 2305 rows, got ${result.length}`);
  if (result.at(-1) !== 2304) throw new Error("latest page was not collected");
  const expected = JSON.stringify([[0, 999], [1000, 1999], [2000, 2999]]);
  if (JSON.stringify(ranges) !== expected) throw new Error(`unexpected ranges ${JSON.stringify(ranges)}`);
});

Deno.test("collectPages respects maxRows", async () => {
  const source = Array.from({ length: 5000 }, (_, index) => index);
  const result = await collectPages(
    async (from, to) => source.slice(from, to + 1),
    { maxRows: 1500 },
  );
  if (result.length !== 1500) throw new Error(`expected 1500 rows, got ${result.length}`);
  if (result.at(-1) !== 1499) throw new Error("maxRows boundary is incorrect");
});

Deno.test("collectPages stops on an empty first page", async () => {
  const result = await collectPages(async () => []);
  if (result.length !== 0) throw new Error("expected an empty result");
});
