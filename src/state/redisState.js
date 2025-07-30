const Redis = require('ioredis');

// Redis otimizado com scripts Lua para atomicidade
const redis = new Redis({
  host: 'redis',
  port: 6379,
  retryDelayOnFailover: 50,
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
  commandTimeout: 5000,
  enableAutoPipelining: true,
  lazyConnect: true
});

// Script Lua para operação atômica de processamento de pagamento
const PROCESS_PAYMENT_SCRIPT = `
  local correlation_id = ARGV[1]
  local prefix = ARGV[2]
  local amount_cents = tonumber(ARGV[3])
  local timestamp = tonumber(ARGV[4])
  local amount_float = amount_cents / 100
  
  local processed_key = "processed:" .. prefix
  local count_key = "count:" .. prefix
  local amount_key = "amount:" .. prefix
  local payments_key = "payments:" .. prefix
  
  -- ATOMICIDADE TOTAL: Usar SADD como barreira única de duplicação
  local added = redis.call('SADD', processed_key, correlation_id)
  
  if added == 1 then
    -- Garantia: só entra aqui se realmente foi adicionado pela primeira vez
    redis.call('INCR', count_key)
    redis.call('INCRBYFLOAT', amount_key, amount_float)
    
    -- Armazenar detalhes do pagamento para consultas com filtro de data
    local payment_data = timestamp .. ":" .. amount_cents .. ":" .. correlation_id
    redis.call('LPUSH', payments_key, payment_data)
    
    -- Garantir precisão numérica arredondando o float
    local current_amount = redis.call('GET', amount_key)
    if current_amount then
      local rounded = math.floor(tonumber(current_amount) * 100 + 0.5) / 100
      redis.call('SET', amount_key, tostring(rounded))
    end
    
    return 1  -- Processado com sucesso
  else
    return 0  -- Já processado anteriormente
  end
`;

// Script Lua para limpeza de dados órfãos
const CLEANUP_SCRIPT = `
  local processing_key = "payments:processing"
  local members = redis.call('SMEMBERS', processing_key)
  
  if #members > 1000 then
    redis.call('DEL', processing_key)
    return #members
  end
  
  return 0
`;

// Definir scripts no Redis
redis.defineCommand('processPayment', {
  numberOfKeys: 0,
  lua: PROCESS_PAYMENT_SCRIPT
});

redis.defineCommand('cleanup', {
  numberOfKeys: 0,
  lua: CLEANUP_SCRIPT
});

class SharedPaymentStorage {
  constructor(prefix) {
    this.prefix = prefix;
  }

  async exists(correlationId) {
    try {
      const exists = await redis.sismember(`processed:${this.prefix}`, correlationId);
      return exists === 1;
    } catch (error) {
      return false;
    }
  }

  async push(amount, timestamp, correlationId) {
    try {
      // Usa script Lua para operação 100% atômica
      const result = await redis.processPayment(
        correlationId,
        this.prefix,
        amount, // amount já está em cents
        timestamp
      );
      
      return result === 1;
    } catch (error) {
      return false;
    }
  }

  async remove(correlationId) {
    try {
      // Remove de todas as estruturas
      const pipeline = redis.pipeline()
        .srem(`processed:${this.prefix}`, correlationId)
        .decr(`count:${this.prefix}`)
        .lrem(`payments:${this.prefix}`, 1, correlationId);
      
      await pipeline.exec();
      return true;
    } catch (error) {
      return false;
    }
  }

  async getSummary(fromTimestamp = null, toTimestamp = null) {
    try {
      if (!fromTimestamp && !toTimestamp) {
        // Consulta rápida sem filtros
        const pipeline = redis.pipeline()
          .get(`count:${this.prefix}`)
          .get(`amount:${this.prefix}`);
        
        const results = await pipeline.exec();
        
        if (!results || results.some(([err]) => err)) {
          return { totalRequests: 0, totalAmount: 0 };
        }
        
        const totalRequests = parseInt(results[0][1]) || 0;
        const totalAmount = parseFloat(results[1][1]) || 0;
        
        return {
          totalRequests,
          totalAmount: Math.round(totalAmount * 100) / 100
        };
      } else {
        // Consulta com filtros de data
        return await this.getSummaryWithDateFilter(fromTimestamp, toTimestamp);
      }
    } catch (error) {
      return { totalRequests: 0, totalAmount: 0 };
    }
  }

  async getSummaryWithDateFilter(fromTimestamp, toTimestamp) {
    try {
      const payments = await redis.lrange(`payments:${this.prefix}`, 0, -1);
      
      let totalRequests = 0;
      let totalAmount = 0;
      
      for (const payment of payments) {
        const [timestamp, amountCents] = payment.split(':');
        const ts = parseInt(timestamp);
        const amount = parseInt(amountCents);
        
        if (fromTimestamp && ts < fromTimestamp) continue;
        if (toTimestamp && ts > toTimestamp) continue;
        
        totalRequests++;
        totalAmount += amount;
      }
      
      return {
        totalRequests,
        totalAmount: Math.round((totalAmount / 100) * 100) / 100
      };
    } catch (error) {
      return { totalRequests: 0, totalAmount: 0 };
    }
  }
}

const sharedState = {
  default: new SharedPaymentStorage('default'),
  fallback: new SharedPaymentStorage('fallback')
};

module.exports = { sharedState, redis };