from pathlib import Path

path = Path('.github/hotfix_recovery_180m_v765.py')
source = path.read_text()

# Keep the already-validated policy/engine/test/migration/static-test edits, but exclude
# permanent workflow edits because the Actions token cannot modify workflow files.
marker = '# ---------------------------------------------------------------------------\n# Permanent deploy workflows.'
if marker not in source:
    raise SystemExit('permanent workflow marker missing')
source = source.split(marker, 1)[0]

exec(compile(source, str(path), 'exec'), {'__name__': '__main__'})
print('v765 source-only patch staged successfully')
