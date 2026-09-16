#!/usr/bin/env node
/**
 * Build the single-file deployable for boo-r1-shadow.
 *
 * Supabase edge deployment resolves relative imports against the uploaded file
 * set; inlining the two pure dependencies removes that coupling entirely, so
 * what runs in production is one artifact whose hash we can compare against the
 * repository (regression test 24).
 *
 * Comments are stripped from the inlined modules. The reasoning behind every
 * rule lives in the repository sources, which are the source of truth; the
 * bundle is generated output and is never edited by hand.
 *
 * Usage: node scripts/boo/bundle-shadow.mjs [--out dist/boo-r1-shadow.bundle.ts]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUT = argOf("--out") ?? "dist/boo-r1-shadow.bundle.ts";

const SOURCES = {
  decimal: "supabase/functions/_shared/boo/decimal.mjs",
  strategy: "supabase/functions/_shared/boo/r1-strategy.mjs",
  entry: "supabase/functions/boo-r1-shadow/index.ts",
};

/** Drop comment-only lines. Safe here because these files never open a block
 *  comment mid-expression, and no line that starts with `//` is inside a
 *  template literal or regex. `// @ts-` pragmas are preserved. */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    const s = line.trim();
    if (inBlock) {
      if (s.includes("*/")) inBlock = false;
      continue;
    }
    if (s.startsWith("/*")) {
      if (!s.includes("*/")) inBlock = true;
      continue;
    }
    if (s.startsWith("//") && !s.startsWith("// @ts")) continue;
    out.push(line);
  }
  const collapsed = [];
  let blank = false;
  for (const l of out) {
    if (l.trim() === "") {
      if (blank) continue;
      blank = true;
    } else blank = false;
    collapsed.push(l);
  }
  return collapsed.join("\n");
}

/**
 * Remove only the import statements whose specifier matches `test`.
 *
 * Done by scanning statement by statement rather than with one regex: a
 * non-greedy `[\s\S]*?` across lines happily spans from an earlier `import {`
 * to a later module specifier and deletes everything in between, which silently
 * dropped the supabase-js import the first time this ran.
 */
function dropLocalImports(src, test) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\s/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Collect the whole statement, which may span lines, up to its `";`.
    let stmt = lines[i];
    let j = i;
    while (!/;\s*$/.test(stmt) && j + 1 < lines.length) stmt += "\n" + lines[++j];
    const spec = stmt.match(/from\s+"([^"]+)"/)?.[1] ?? "";
    if (test(spec)) {
      i = j; // drop the whole statement
      continue;
    }
    for (let k = i; k <= j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join("\n");
}

const isLocalBooImport = (spec) => /(^|\/)(\.\.\/_shared\/boo\/|\.\/)(decimal|r1-strategy)\.mjs$/.test(spec) ||
  spec === "./decimal.mjs" || spec.startsWith("../_shared/boo/");

const decimal = stripComments(readFileSync(SOURCES.decimal, "utf8"));
const strategy = dropLocalImports(stripComments(readFileSync(SOURCES.strategy, "utf8")), isLocalBooImport);
const entry = dropLocalImports(stripComments(readFileSync(SOURCES.entry, "utf8")), isLocalBooImport);

const bundle = [
  "// @ts-nocheck",
  "// GENERATED BUNDLE - regenerate with scripts/boo/bundle-shadow.mjs",
  "// Sources: boo-r1-shadow/index.ts + _shared/boo/{decimal,r1-strategy}.mjs",
  "// Comments live in the repository sources, not here.",
  "",
  decimal,
  strategy,
  entry,
].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);

const sha = createHash("sha256").update(bundle).digest("hex");
const sourceShas = Object.fromEntries(
  Object.entries(SOURCES).map(([k, p]) => [k, createHash("sha256").update(readFileSync(p)).digest("hex")]),
);
console.log(`wrote ${OUT} (${bundle.length} bytes)`);
console.log(`bundle sha256 : ${sha}`);
for (const [k, v] of Object.entries(sourceShas)) console.log(`source ${k.padEnd(9)}: ${v}`);

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
