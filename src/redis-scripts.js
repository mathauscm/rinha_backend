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

-- Incrementa contadores globais ATOMICAMENTE
redis.call('INCR', 'total_payments')
redis.call('INCRBYFLOAT', 'total_amount', amount)

return {ok = 'STORED'}
`;

// Script para buscar summary SIMPLIFICADO
const GET_SUMMARY_SCRIPT = `
-- Função de arredondamento preciso
local function round2(num)
    if num == nil then return 0 end
    local rounded = math.floor(tonumber(num) * 100 + 0.5) / 100
    return rounded == -0 and 0 or rounded
end

-- Busca todos os IDs
local defaultIds = redis.call('ZRANGE', 'summary:default:history', 0, -1)
local fallbackIds = redis.call('ZRANGE', 'summary:fallback:history', 0, -1)

local result = {
    defaultCount = #defaultIds,
    fallbackCount = #fallbackIds,
    defaultTotal = 0,
    fallbackTotal = 0
}

-- Calcula total default sem batching por enquanto
if #defaultIds > 0 then
    local amounts = redis.call('HMGET', 'summary:default:data', unpack(defaultIds))
    for _, amount in ipairs(amounts) do
        if amount then
            result.defaultTotal = result.defaultTotal + tonumber(amount)
        end
    end
    result.defaultTotal = round2(result.defaultTotal)
end

-- Calcula total fallback sem batching por enquanto
if #fallbackIds > 0 then
    local amounts = redis.call('HMGET', 'summary:fallback:data', unpack(fallbackIds))
    for _, amount in ipairs(amounts) do
        if amount then
            result.fallbackTotal = result.fallbackTotal + tonumber(amount)
        end
    end
    result.fallbackTotal = round2(result.fallbackTotal)
end

return result
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
      scriptShas.getSummary = await redisClient.script('LOAD', GET_SUMMARY_SCRIPT);
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
    console.log('DEBUG: processPaymentAtomic called with:', correlationId, scriptShas.processPayment ? 'SHA found' : 'SHA missing');
    
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
    // DIRETO via pipeline Redis - sem Lua script problemático
    const pipeline = redisClient.pipeline();
    pipeline.zrange('summary:default:history', 0, -1);
    pipeline.zrange('summary:fallback:history', 0, -1);
    const [defaultIds, fallbackIds] = await pipeline.exec();
    
    const defaultList = defaultIds[1] || [];
    const fallbackList = fallbackIds[1] || [];
    
    let defaultTotal = 0, fallbackTotal = 0;
    
    // Busca valores atomicamente se há registros
    if (defaultList.length > 0) {
      const amounts = await redisClient.hmget('summary:default:data', ...defaultList);
      defaultTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    if (fallbackList.length > 0) {
      const amounts = await redisClient.hmget('summary:fallback:data', ...fallbackList);
      fallbackTotal = amounts.reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0);
    }
    
    // Arredondamento preciso
    const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;
    
    return {
      default: {
        totalRequests: defaultList.length,
        totalAmount: round2(defaultTotal)
      },
      fallback: {
        totalRequests: fallbackList.length,
        totalAmount: round2(fallbackTotal)
      }
    };
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