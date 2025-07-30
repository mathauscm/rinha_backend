const { redis } = require('../state/redisState');

// Script para verificar estado atual do Redis
async function checkRedisConsistency() {
  try {
    const pipeline = redis.pipeline()
      .scard('payments:processing')
      .scard('processed:default')
      .scard('processed:fallback')
      .get('count:default')
      .get('count:fallback')
      .get('amount:default')
      .get('amount:fallback');
    
    const results = await pipeline.exec();
    
    return {
      processing: results[0][1] || 0,
      processedDefault: results[1][1] || 0,
      processedFallback: results[2][1] || 0,
      countDefault: parseInt(results[3][1]) || 0,
      countFallback: parseInt(results[4][1]) || 0,
      amountDefault: parseFloat(results[5][1]) || 0,
      amountFallback: parseFloat(results[6][1]) || 0
    };
  } catch (error) {
    return null;
  }
}

// Função para limpar estado Redis (apenas para testes)
async function resetRedisState() {
  try {
    const keys = await redis.keys('*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  checkRedisConsistency,
  resetRedisState
};