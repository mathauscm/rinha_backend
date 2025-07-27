const { Pool } = require('pg');

const pool = new Pool({
  host: 'postgres',
  port: 5432,
  user: 'rinha',
  password: 'rinha123',
  database: 'rinhadb',
  max: 50,
  min: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 1000,
  acquireTimeoutMillis: 500,
  statement_timeout: 100,
  query_timeout: 100,
});

async function getPaymentsSummary(from, to) {
  let query = `
    SELECT
      payment_processor,
      COUNT(*) as totalrequests,
      SUM(amount) as totalamount
    FROM payments
  `;

  const conditions = [];
  const values = [];

  if (from) {
    values.push(from.toISOString());
    conditions.push(`requested_at >= $${values.length}`);
  }
  if (to) {
    values.push(to.toISOString());
    conditions.push(`requested_at <= $${values.length}`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ' GROUP BY payment_processor';

  const res = await pool.query(query, values);

  const summary = { default: { totalRequests: 0, totalAmount: 0 }, fallback: { totalRequests: 0, totalAmount: 0 } };

  for (const row of res.rows) {
    if (row.payment_processor === 'default') {
      summary.default.totalRequests = parseInt(row.totalrequests, 10);
      summary.default.totalAmount = parseFloat(row.totalamount);
    } else if (row.payment_processor === 'fallback') {
      summary.fallback.totalRequests = parseInt(row.totalrequests, 10);
      summary.fallback.totalAmount = parseFloat(row.totalamount);
    }
  }

  return summary;
}

module.exports = {
  getPaymentsSummary,
};
