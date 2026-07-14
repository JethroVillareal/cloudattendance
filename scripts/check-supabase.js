'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const separator = line.indexOf('=');
  if (separator < 1 || line.trim().startsWith('#')) continue;
  const key = line.slice(0, separator).trim();
  let value = line.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[key] = value;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000
});

(async () => {
  try {
    const result = await pool.query(`SELECT
      (SELECT COUNT(*) FROM app_state) AS app_state,
      (SELECT COUNT(*) FROM employee_records) AS employees,
      (SELECT COUNT(*) FROM attendance_records) AS attendance,
      (SELECT COUNT(*) FROM reader_records) AS readers`);
    console.log(JSON.stringify({ connected: true, counts: result.rows[0] }));
  } catch (error) {
    console.log(JSON.stringify({ connected: false, error: error.code || error.message }));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
