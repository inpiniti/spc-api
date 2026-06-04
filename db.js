const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'spcdb',
  user: process.env.PGUSER || 'spc',
  password: process.env.PGPASSWORD || '1234',
});

pool.on('error', (err) => console.error('[PG] pool error:', err.message));

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
