"""Small conservative review gate; not a substitute for PostgreSQL lock analysis."""
from pathlib import Path
import re
import sys

errors = []
for path in sorted((Path(__file__).resolve().parents[1] / 'migrations').glob('*.sql')):
    sql = re.sub(r'--[^\n]*', '', path.read_text(encoding='utf-8')).upper()
    if re.search(r'CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)', sql): errors.append(f'{path.name}: CREATE INDEX must use CONCURRENTLY')
    if re.search(r'\bDROP\s+(?:COLUMN|TABLE)\b|\bTRUNCATE\b', sql): errors.append(f'{path.name}: destructive operations need a separate reviewed contract release')
    if 'CONCURRENTLY' in sql and '-- no-transaction' not in path.read_text(encoding='utf-8'): errors.append(f'{path.name}: concurrent index must opt out of transaction')
if errors:
    print('\n'.join(errors)); sys.exit(1)
print('Migration review gate passed. Runtime lock behavior still requires a database test.')
