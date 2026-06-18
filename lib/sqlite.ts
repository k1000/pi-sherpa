import { createRequire } from "node:module";

export type SqliteStatement = {
  run: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
};

export type SqliteDatabase = {
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
  transaction: <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => unknown;
  close: () => unknown;
};

export function openSqliteDatabase(dbPath: string, purpose = "Sherpa SQLite storage"): SqliteDatabase {
  const require = createRequire(import.meta.url);
  try {
    const { Database } = require("bun:sqlite") as { Database: { open: (path: string, options?: { create?: boolean }) => SqliteDatabase } };
    return Database.open(dbPath, { create: true });
  } catch (bunError: any) {
    try {
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => { exec: (sql: string) => unknown; prepare: (sql: string) => SqliteStatement; close: () => unknown } };
      const db = new DatabaseSync(dbPath);
      return {
        exec: (sql: string) => db.exec(sql),
        query: (sql: string) => db.prepare(sql),
        transaction: <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => {
          db.exec("BEGIN");
          try {
            const result = fn(...args);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
            throw error;
          }
        },
        close: () => db.close(),
      };
    } catch (nodeError: any) {
      throw new Error(`SQLite is unavailable. ${purpose} requires Bun's bun:sqlite or Node's experimental node:sqlite. bun:sqlite error: ${bunError?.message ?? bunError}; node:sqlite error: ${nodeError?.message ?? nodeError}`);
    }
  }
}
