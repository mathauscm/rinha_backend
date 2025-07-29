const redisClient = require('../cache/redisClient');
const db = require('../db');
const { validate: uuidValidate } = require('uuid');

async function handlePostPayments(req, res, body) {
  const { correlationId, amount } = body;

  if (!correlationId || !uuidValidate(correlationId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('{"error":"Invalid or missing correlationId"}');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('{"error":"Invalid or missing amount"}');
  }

  try {
    const exists = await redisClient.hexists('payments:processing', correlationId);
    if (exists) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Payment already processing"}');
    }

    await redisClient.hset(
      'payments:processing',
      correlationId,
      JSON.stringify({ correlationId, amount, requestedAt: new Date().toISOString() })
    );
    await redisClient.lpush('payments:queue', correlationId);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"message":"Payment queued"}');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal Server Error"}');
  }
}

async function handleGetPaymentsSummary(req, res, searchParams) {
  try {
    const from = searchParams.get('from') ? new Date(searchParams.get('from')) : null;
    const to = searchParams.get('to') ? new Date(searchParams.get('to')) : null;

    const summary = await db.getPaymentsSummary(from, to);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal Server Error"}');
  }
}

module.exports = {
  handlePostPayments,
  handleGetPaymentsSummary,
};
