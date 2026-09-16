// The account observation from p10_portfolio is only usable while freshPortfolio still
// accepts it (3s). Production failed 21 healthy cycles over three days as
// INCOMPLETE_OR_STALE_SNAPSHOT with fetch latencies of 236-911ms but ages of 3514-5052ms
// at classification: the budget was spent on our own DB round trips taken between the
// fetch and the check, not on the exchange.
//
// This is a source-level check because the gates live in index.ts, which calls Deno.serve
// at import and so cannot be imported into a test. It asserts the one property that
// caused the incidents: on each gate path the DB reads precede the fetch, and nothing is
// awaited between the fetch and the classification that consumes it.
import {assert, assertEquals} from "jsr:@std/assert@1";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// Every function in index.ts is declared at column 0, so a body runs from its own
// declaration to the next top-level declaration. That avoids brace-counting, which
// miscounts across the braces that appear inside this file's string literals.
function body(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = src.slice(start + 1).search(/\n(?:async function |function |const |let |Deno\.serve)/);
  assert(next >= 0, `could not bound the body of ${name}`);
  return src.slice(start, start + 1 + next);
}

Deno.test("readOpsPair fetches the account observation after every DB read it needs", () => {
  const b = body("readOpsPair");
  const fetchAt = b.indexOf('gw({action:"p10_portfolio"}');
  const classifyAt = b.indexOf("classifyPortfolio(");
  assert(fetchAt >= 0 && classifyAt >= 0);
  assert(fetchAt < classifyAt, "the observation must be fetched before it is classified");

  // Every `db.` read and every helper that reads the DB must come before the fetch.
  for (const marker of ["readOpsPositions(", "manualPositionAllowances(", "readOpsOrders(", "db.from("]) {
    const last = b.lastIndexOf(marker);
    assert(last >= 0, `${marker} missing from readOpsPair`);
    assert(last < fetchAt, `${marker} runs after the p10_portfolio fetch and spends its freshness budget`);
  }

  // Nothing at all is awaited between the fetch and the classification.
  const between = b.slice(fetchAt, classifyAt);
  assertEquals(between.match(/await /g), null, "no await may sit between the fetch and classifyPortfolio");
});

Deno.test("closePos reads its allowlist before the account observation", () => {
  const b = body("closePos");
  const classifyAt = b.indexOf("classifyPortfolio(");
  assert(classifyAt >= 0, "exit path gate not found");
  // closePos also fetches the portfolio on the early pending-receipt branch, which returns
  // without classifying. Anchor on the fetch that actually feeds this gate.
  const fetchAt = b.lastIndexOf('gw({action:"p10_portfolio"})', classifyAt);
  assert(fetchAt >= 0, "no account observation feeds the exit gate");
  const manualAt = b.indexOf("manualPositionAllowances(");
  assert(manualAt >= 0 && manualAt < fetchAt, "the allowlist read must precede the fetch");
  assert(fetchAt < classifyAt);
  assertEquals(
    b.slice(fetchAt, classifyAt).match(/await /g),
    null,
    "no await may sit between the exit fetch and classifyPortfolio",
  );
});
