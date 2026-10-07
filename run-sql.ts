/**
 * SQL execution entry point: load a supplied SQL file and run it against DATABASE_URL.
 * DDL and metadata changes use this path; Kysely is used for application queries.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const sqlPath = process.argv[2];
if (!sqlPath) {
  console.error("Usage: run-sql <path-to-file.sql>");
  process.exit(1);
}

// Credentials come from the runner's environment; do not print the connection string.
const sql = readFileSync(sqlPath, "utf-8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  const result = await client.query(sql);
// A file can contain multiple SQL statements; display the final statement's result.
  const rows = Array.isArray(result) ? result.at(-1)!.rows : result.rows;
  if (rows.length) {
    console.table(rows);
  } else {
    console.log(`OK — ${(Array.isArray(result) ? result.at(-1)! : result).command}, ${(Array.isArray(result) ? result.at(-1)! : result).rowCount} row(s)`);
  }
} finally {
  await client.end();
}
