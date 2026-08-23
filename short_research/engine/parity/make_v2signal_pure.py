"""Derive an importable module from the deployed market-v2-signal source.

Mechanical, not a transcription: it reads supabase/functions/market-v2-signal/index.ts and
removes only the jsr type-reference import and the Deno.serve entrypoint, then appends an
export list. Every gate function under test is therefore byte-for-byte the deployed one.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC = ROOT / "supabase/functions/market-v2-signal/index.ts"
OUT = pathlib.Path(__file__).with_name("_v2signal_pure.ts")

lines = SRC.read_text().split("\n")
body = "\n".join(l for l in lines
                 if not l.startswith('import "jsr:') and not l.startswith("Deno.serve("))
assert "Deno.serve(" not in body, "entrypoint not stripped"
for fn in ("function i46Check", "function detectI46", "function detectP10",
           "function prepare", "function bench"):
    assert fn in body, f"missing {fn}"
body += "\nexport { prepare, bench, i46Check, detectI46, detectP10, floor };\n"
OUT.write_text(body)
print(f"wrote {OUT.relative_to(ROOT)} ({len(body)} chars) from {SRC.relative_to(ROOT)}")
