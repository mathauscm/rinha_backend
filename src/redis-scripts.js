// Lua scripts para operações atômicas ultra-rápidas
const redisClient = require('./cache/redisClient');

// Script para processar pagamento com verificação duplicada
const PROCESS_PAYMENT_SCRIPT = `
local correlationId = ARGV[1]
local paymentData = ARGV[2]

-- Verifica se já está sendo processado
if redis.call('HEXISTS', 'payments:processing', correlationId) == 1 then
    return {err = 'ALREADY_PROCESSING'}
end

-- Adiciona atomicamente
redis.call('HSET', 'payments:processing', correlationId, paymentData)
redis.call('LPUSH', 'payments:queue', correlationId)

return {ok = 'QUEUED'}
`;

// Script para armazenar summary otimizado
const STORE_SUMMARY_SCRIPT = `
local prefix = ARGV[1]
local correlationId = ARGV[2] 
local amount = ARGV[3]
local timestamp = ARGV[4]

-- Pipeline atômico
redis.call('HSET', 'summary:' .. prefix .. ':data', correlationId, amount)
redis.call('ZADD', 'summary:' .. prefix .. ':history', timestamp, correlationId)
redis.call('HDEL', 'payments:processing', correlationId)

return {ok = 'STORED'}
`;

// Script para buscar summary ultra-otimizado
const GET_SUMMARY_SCRIPT = `
local fromTs = tonumber(ARGV[1]) or 0
local toTs = tonumber(ARGV[2]) or 9999999999999

-- Busca IDs no range de timestamp
local defaultIds = redis.call('ZRANGEBYSCORE', 'summary:default:history', fromTs, toTs)
local fallbackIds = redis.call('ZRANGEBYSCORE', 'summary:fallback:history', fromTs, toTs)

local result = {
    defaultCount = #defaultIds,
    fallbackCount = #fallbackIds,
    defaultAmounts = {},
    fallbackAmounts = {}
}

-- Busca amounts se tiver IDs
if #defaultIds > 0 then
    result.defaultAmounts = redis.call('HMGET', 'summary:default:data', unpack(defaultIds))
end

if #fallbackIds > 0 then
    result.fallbackAmounts = redis.call('HMGET', 'summary:fallback:data', unpack(fallbackIds))
end

return result
`;

// Cache dos scripts SHA
let scriptShas = {};

async function loadScripts() {
  try {
    scriptShas.processPayment = await redisClient.script('LOAD', PROCESS_PAYMENT_SCRIPT);
    scriptShas.storeSummary = await redisClient.script('LOAD', STORE_SUMMARY_SCRIPT);
    scriptShas.getSummary = await redisClient.script('LOAD', GET_SUMMARY_SCRIPT);
    console.log('Redis Lua scripts loaded successfully');
  } catch (err) {
    console.error('Failed to load Redis scripts:', err);
  }
}

async function processPaymentAtomic(correlationId, paymentData) {
  try {
    const result = await redisClient.evalsha(
      scriptShas.processPayment,
      0,
      correlationId,
      paymentData
    );
    
    if (result.err) {
      throw new Error(result.err);
    }
    
    return result;
  } catch (err) {
    if (err.message.includes('NOSCRIPT')) {
      // Recarrega script se não encontrado
      await loadScripts();
      return processPaymentAtomic(correlationId, paymentData);
    }
    throw err;
  }
}

async function storeSummaryAtomic(prefix, correlationId, amount, timestamp) {
  try {
    return await redisClient.evalsha(
      scriptShas.storeSummary,
      0,
      prefix,
      correlationId,
      amount.toString(),
      timestamp.toString()
    );
  } catch (err) {
    if (err.message.includes('NOSCRIPT')) {
      await loadScripts();
      return storeSummaryAtomic(prefix, correlationId, amount, timestamp);
    }
    throw err;
  }
}

async function getSummaryAtomic(fromTs, toTs) {
  try {
    const result = await redisClient.evalsha(
      scriptShas.getSummary,
      0,
      (fromTs || 0).toString(),
      (toTs || Date.now() + 86400000).toString()
    );
    
    // Processa resultado
    const defaultAmounts = (result.defaultAmounts || []).map(a => parseFloat(a) || 0);
    const fallbackAmounts = (result.fallbackAmounts || []).map(a => parseFloat(a) || 0);
    
    return {
      default: {
        totalRequests: result.defaultCount,
        totalAmount: Math.round(defaultAmounts.reduce((sum, a) => sum + a, 0) * 100) / 100
      },
      fallback: {
        totalRequests: result.fallbackCount,
        totalAmount: Math.round(fallbackAmounts.reduce((sum, a) => sum + a, 0) * 100) / 100
      }
    };
  } catch (err) {
    if (err.message.includes('NOSCRIPT')) {
      await loadScripts();
      return getSummaryAtomic(fromTs, toTs);
    }
    throw err;
  }
}

// Inicializa scripts na startup
loadScripts();

module.exports = {
  processPaymentAtomic,
  storeSummaryAtomic,
  getSummaryAtomic,
  loadScripts
};