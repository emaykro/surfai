const { Pool } = require("pg");

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/surfai";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
});

module.exports = { pool, DATABASE_URL };
