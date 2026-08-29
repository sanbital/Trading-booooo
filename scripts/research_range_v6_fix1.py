from pathlib import Path

p = Path('supabase/functions/regime-router-v5-research/simulator.ts')
s = p.read_text()
old = '''      const protected = isLong
        ? entry * (1 + requiredResidualGrossBps / 10_000)
        : entry * (1 - requiredResidualGrossBps / 10_000);
      stop = isLong ? Math.max(stop, protected) : Math.min(stop, protected);
'''
new = '''      const protectedStop = isLong
        ? entry * (1 + requiredResidualGrossBps / 10_000)
        : entry * (1 - requiredResidualGrossBps / 10_000);
      stop = isLong ? Math.max(stop, protectedStop) : Math.min(stop, protectedStop);
'''
if s.count(old) != 1:
    raise SystemExit(f'protected stop patch expected 1 match, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
print('RANGE V6 protected-stop identifier fixed')
