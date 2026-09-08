/** Stages the exit engine into gateway/ so the Docker image can contain it.
 *
 * The gateway image is built with gateway/ as its context, so it cannot COPY from
 * supabase/functions/_shared. Committing a second copy of the engine would let the
 * shadow drift away from the engine the executor actually runs, so the copy is
 * generated at deploy time instead and git-ignored. This mirrors what
 * patch-trade-history.mjs already does for the trade-history routes.
 *
 * Run from the repository root, before `flyctl deploy`.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const sharedDir = join(gatewayDir, "..", "supabase", "functions", "_shared");

// leader-exit-r4 imports leader-exit-r3, so both are required for the import to resolve.
export const STAGED_ENGINE_FILES = ["leader-exit-r3.mjs", "leader-exit-r4.mjs"];

export function stageEngine({ from = sharedDir, to = gatewayDir } = {}) {
  mkdirSync(to, { recursive: true });
  const staged = [];
  for (const name of STAGED_ENGINE_FILES) {
    const source = join(from, name);
    const bytes = readFileSync(source); // fail loudly if the engine moved
    copyFileSync(source, join(to, name));
    staged.push({ name, bytes: bytes.length });
  }
  return staged;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const { name, bytes } of stageEngine()) {
    console.log(`Staged ${name} into the gateway image (${bytes} bytes).`);
  }
}
