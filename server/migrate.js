/**
 * Simple migration runner — executes SQL files from migrations/ in order.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Usage: node migrate.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

async function migrate() {
  const client = await pool.connect();
  try {
    // Ensure migration tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Read migration files sorted by name
    const dir = path.join(__dirname, "migrations");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      // Check if already applied
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`  skip: ${file} (already applied)`);
        continue;
      }

      // Apply migration
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  done: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.log("Migrations complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
