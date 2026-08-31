import { routeLane } from "./v10_lanes.ts";
import golden from "./v10_lanes.golden.json" with { type: "json" };

for (const fixture of golden.fixtures) {
  Deno.test(`v10 lanes golden: ${fixture.name}`, () => {
    const actual = routeLane(fixture.input);
    const expected = fixture.expected;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${fixture.name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  });
}
