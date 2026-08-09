function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("the first -4% stop sells only the first 50% tranche", () => {
  assert(
    source.includes(`} else if (grossReturnPct <= -4) {
          decision = {
            action: "STOP",
            fraction: 0.5,
            reason: "HALF_HOLD_STOP_LOSS_4",`),
    "the first -4% observation must sell 50%, not the complete position",
  );
  assert(
    !source.includes("FULL_STOP_LOSS_4"),
    "the accidental first-stage full-stop reason must not remain wired",
  );
});

Deno.test("the residual half exits in full at either +10% or -4%", () => {
  assert(
    source.includes(`if (residualNetReturnPct >= 10) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: "RESIDUAL_TAKE_PROFIT_10",`),
    "the residual +10% exit must sell the complete remainder",
  );
  assert(
    source.includes(`} else if (residualNetReturnPct <= -4) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: "RESIDUAL_STOP_LOSS_4",`),
    "the residual -4% stop must sell the complete remainder",
  );
});
