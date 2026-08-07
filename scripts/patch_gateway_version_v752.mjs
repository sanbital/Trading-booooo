import fs from "node:fs";

const path = "gateway/server.mjs";
const from = 'const VERSION = "7.5.1-RESIDUAL-TP50-SL10";';
const to = 'const VERSION = "7.5.2-RESIDUAL-TP10-SL4";';
const source = fs.readFileSync(path, "utf8");

if (source.includes(to)) {
  console.log("Gateway version already aligned to v7.5.2");
  process.exit(0);
}
if (!source.includes(from)) {
  throw new Error("gateway VERSION anchor not found; refusing an unsafe blind patch");
}

fs.writeFileSync(path, source.replace(from, to));
console.log("Aligned gateway VERSION to 7.5.2-RESIDUAL-TP10-SL4");
