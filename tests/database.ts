import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/db/store';

/** Execute repository SQL against SQLite; API boundaries stay mocked. */
export function testStore(): { store: Store; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...args: (string | number | null)[]) { values = args; return statement; },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...values);
        return column ? row?.[column] ?? null : row ?? null;
      },
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
    };
    return statement;
  };
  const adapter = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { store: new Store(adapter as unknown as D1Database), sqlite };
}
