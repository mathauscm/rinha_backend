const { processPaymentAtomic, getSummaryAtomic } = require('../redis-scripts');
const { validate: uuidValidate } = require('uuid');
const { encode } = require('@msgpack/msgpack');

// Pre-compiled responses para economizar CPU
const RESPONSES = {
  INVALID_UUID: '{"error":"Invalid or missing correlationId"}',
  INVALID_AMOUNT: '{"error":"Invalid or missing amount"}',
  ALREADY_PROCESSING: '{"error":"Payment already processing"}',
  QUEUED: '{"message":"Payment queued"}',
  INTERNAL_ERROR: '{"error":"Internal Server Error"}'
};

// Pool de objetos reutilizáveis
const paymentObjectPool = [];
function getPaymentObject() {
  return paymentObjectPool.pop() || {};
}
function returnPaymentObject(obj) {
  // Limpa o objeto
  for (const key in obj) {
    delete obj[key];
  }
  if (paymentObjectPool.length < 1000) {
    paymentObjectPool.push(obj);
  }
}

async function handlePostPayments(body) {
  const { correlationId, amount } = body;

  // Validações ultra-rápidas
  if (!correlationId || !uuidValidate(correlationId)) {
    throw new Error('INVALID_UUID');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('INVALID_AMOUNT');
  }

  // Usa MessagePack para serialização mais rápida
  const paymentObj = getPaymentObject();
  paymentObj.correlationId = correlationId;
  paymentObj.amount = amount;
  paymentObj.requestedAt = new Date().toISOString();
  
  const serialized = Buffer.from(encode(paymentObj));
  
  // Usa Lua script atômico - mais rápido que pipeline
  await processPaymentAtomic(correlationId, serialized);
  
  returnPaymentObject(paymentObj);
}

async function handleGetPaymentsSummary(searchParams) {
  const from = searchParams.get('from') ? new Date(searchParams.get('from')) : null;
  const to = searchParams.get('to') ? new Date(searchParams.get('to')) : null;

  const fromTs = from ? from.getTime() : null;
  const toTs = to ? to.getTime() : null;

  return await getSummaryAtomic(fromTs, toTs);
}

module.exports = {
  handlePostPayments,
  handleGetPaymentsSummary,
};