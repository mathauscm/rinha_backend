const { processPaymentAtomic, getSummaryAtomic } = require('../redis-scripts');
const { validate: uuidValidate } = require('uuid');
const { encode } = require('@msgpack/msgpack');

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
  if (!correlationId || typeof correlationId !== 'string' || !uuidValidate(correlationId)) {
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
  
  // USA SCRIPT ATÔMICO para evitar inconsistências
  try {
    await processPaymentAtomic(correlationId, serialized.toString('base64'));
    console.log(`DEBUG: Payment ${correlationId} queued successfully`);
  } catch (err) {
    if (err.message === 'ALREADY_PROCESSING') {
      console.log(`DEBUG: Payment ${correlationId} already processing`);
      throw new Error('ALREADY_PROCESSING');
    }
    console.error(`DEBUG: Error queueing payment ${correlationId}:`, err);
    throw err;
  }
  
  returnPaymentObject(paymentObj);
}

async function handleGetPaymentsSummary() {
  try {
    console.log('DEBUG: Summary request started');
    
    // Usa a função de summary atômica corrigida
    const summary = await getSummaryAtomic();
    
    console.log('DEBUG: Summary result:', summary);
    return summary;
    
  } catch (err) {
    console.error('Summary calculation error:', err);
    return {
      default: { totalRequests: 0, totalAmount: 0 },
      fallback: { totalRequests: 0, totalAmount: 0 }
    };
  }
}

module.exports = {
  handlePostPayments,
  handleGetPaymentsSummary,
};