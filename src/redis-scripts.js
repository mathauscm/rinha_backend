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

// Script para armazenar summary ATOMICAMENTE
const STORE_SUMMARY_SCRIPT = `
local prefix = ARGV[1]
local correlationId = ARGV[2] 
local amount = ARGV[3]
local timestamp = ARGV[4]

-- Verifica se já existe para evitar duplicação
local exists = redis.call('HEXISTS', 'summary:' .. prefix .. ':data', correlationId)
if exists == 1 then
    return {err = 'ALREADY_EXISTS'}
end

-- Pipeline atômico
redis.call('HSET', 'summary:' .. prefix .. ':data', correlationId, amount)
redis.call('ZADD', 'summary:' .. prefix .. ':history', timestamp, correlationId)

-- Remove APENAS se foi armazenado com sucesso
redis.call('HDEL', 'payments:processing', correlationId)
redis.call('HDEL', 'payments:retries', correlationId)

return {ok = 'STORED'}
`;

// Cache dos scripts SHA
let scriptShas = {};
let scriptsLoaded = false;

async function loadScripts() {
  if (scriptsLoaded) return;
  
  try {
    // Aguarda conexão Redis estar pronta
    await redisClient.ping();
    
    // Lock simples para evitar carregamento concorrente
    const lockKey = 'scripts:loading';
    const lockValue = process.pid.toString();
    
    const acquired = await redisClient.set(lockKey, lockValue, 'EX', 10, 'NX');
    
    if (acquired === 'OK') {
      scriptShas.processPayment = await redisClient.script('LOAD', PROCESS_PAYMENT_SCRIPT);
      scriptShas.storeSummary = await redisClient.script('LOAD', STORE_SUMMARY_SCRIPT);
      scriptsLoaded = true;
      console.log('Redis Lua scripts loaded successfully');
      await redisClient.del(lockKey);
    } else {
      // Aguarda outro processo carregar
      await new Promise(resolve => setTimeout(resolve, 500));
      return loadScripts();
    }
  } catch (err) {
    console.error('Failed to load Redis scripts:', err);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return loadScripts();
  }
}

async function processPaymentAtomic(correlationId, paymentData) {
  try {
    console.log('DEBUG: processPaymentAtomic called with:', correlationId);
    
    if (!scriptShas.processPayment) {
      console.log('DEBUG: Loading scripts because SHA is missing');
      await loadScripts();
    }
    
    const result = await redisClient.evalsha(
      scriptShas.processPayment,
      0,
      correlationId,
      paymentData
    );
    
    console.log('DEBUG: Script result:', result);
    
    if (result.err) {
      throw new Error(result.err);
    }
    
    return result;
  } catch (err) {
    console.log('DEBUG: Error in processPaymentAtomic:', err.message);
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
    if (!scriptShas.storeSummary) {
      await loadScripts();
    }
    
    const result = await redisClient.evalsha(
      scriptShas.storeSummary,
      0,
      prefix,
      correlationId,
      amount.toString(),
      timestamp.toString()
    );
    
    if (result.err && result.err !== 'ALREADY_EXISTS') {
      throw new Error(result.err);
    }
    
    return result;
  } catch (err) {
    if (err.message.includes('NOSCRIPT')) {
      await loadScripts();
      return storeSummaryAtomic(prefix, correlationId, amount, timestamp);
    }
    throw err;
  }
}

async function getSummaryAtomic() {
  try {
    // Busca dados DIRETAMENTE via pipeline Redis otimizado
    const pipeline = redisClient.pipeline();
    pipeline.zrange('summary:default:history', 0, -1);
    pipeline.zrange('summary:fallback:history', 0, -1);
    
    const results = await pipeline.exec();
    const defaultIds = results[0][1] || [];
    const fallbackIds = results[1][1] || [];
    
    let defaultTotal = 0, fallbackTotal = 0;
    
    // Busca valores atomicamente se há registros
    if (defaultIds.length > 0) {
      const amounts = await redisClient.hmget('summary:default:data', ...defaultIds);
      defaultTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    if (fallbackIds.length > 0) {
      const amounts = await redisClient.hmget('summary:fallback:data', ...fallbackIds);
      fallbackTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    // Arredondamento preciso para evitar problemas de float
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
    
    console.log('DEBUG: getSummaryAtomic result:', result);
    return result;
    
  } catch (err) {
    console.error('getSummaryAtomic error:', err);
    return {
      default: { totalRequests: 0, totalAmount: 0 },
      fallback: { totalRequests: 0, totalAmount: 0 }
    };
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