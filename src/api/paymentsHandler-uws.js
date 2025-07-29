const { processPaymentAtomic } = require('../redis-scripts');
const { validate: uuidValidate } = require('uuid');
const { encode } = require('@msgpack/msgpack');
const redisClient = require('../cache/redisClient');

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
  if (!correlationId || typeof correlationId !== 'string' || correlationId.length === 0) {
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
  } catch (err) {
    if (err.message === 'ALREADY_PROCESSING') {
      throw new Error('ALREADY_PROCESSING');
    }
    throw err;
  }
  
  returnPaymentObject(paymentObj);
}

async function handleGetPaymentsSummary() {
  try {
    console.log('DEBUG: Summary calculation started');
    
    // Busca IDs atomicamente
    const defaultIds = await redisClient.zrange('summary:default:history', 0, -1);
    const fallbackIds = await redisClient.zrange('summary:fallback:history', 0, -1);
    
    console.log(`DEBUG: Found ${defaultIds.length} default, ${fallbackIds.length} fallback`);
    
    let defaultTotal = 0, fallbackTotal = 0;
    
    // Busca valores para default
    if (defaultIds.length > 0) {
      const amounts = await redisClient.hmget('summary:default:data', ...defaultIds);
      console.log('DEBUG: Default amounts sample:', amounts.slice(0, 3));
      defaultTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    // Busca valores para fallback
    if (fallbackIds.length > 0) {
      const amounts = await redisClient.hmget('summary:fallback:data', ...fallbackIds);
      console.log('DEBUG: Fallback amounts sample:', amounts.slice(0, 3));
      fallbackTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    console.log(`DEBUG: Calculated totals - default: ${defaultTotal}, fallback: ${fallbackTotal}`);
    
    // Arredondamento preciso
    const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;
    
    const result = {
      default: {
        totalRequests: defaultIds.length,
        totalAmount: round2(defaultTotal)
      },
      fallback: {
        totalRequests: fallbackIds.length,
        totalAmount: round2(fallbackTotal)
      }
    };
    
    console.log('DEBUG: Final result:', result);
    return result;
    
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