const redisClient = require('../cache/redisClient');

function dateToTimestamp(date) {
  if (!date) return null;
  return date.getTime();
}

function round2(val) {
  const rounded = Math.round(val * 100) / 100;
  return rounded === -0 ? 0 : rounded;
}

async function getPaymentsSummary(from, to) {
  const fromTs = dateToTimestamp(from) || 0;
  const toTs = dateToTimestamp(to) || Date.now() + 86400000; // +24h default
  
  try {
    // Busca dados do Redis usando pipeline para otimizar
    const pipeline = redisClient.pipeline();
    
    // Default processor
    pipeline.zrangebyscore('summary:default:history', fromTs, toTs);
    
    // Fallback processor  
    pipeline.zrangebyscore('summary:fallback:history', fromTs, toTs);
    
    const results = await pipeline.exec();
    
    if (!results || results.length < 2) {
      return {
        default: { totalRequests: 0, totalAmount: 0 },
        fallback: { totalRequests: 0, totalAmount: 0 }
      };
    }
    
    const [defaultIds, fallbackIds] = results.map(r => r[1] || []);
    
    // Busca os valores dos pagamentos
    const pipeline2 = redisClient.pipeline();
    if (defaultIds.length > 0) {
      pipeline2.hmget('summary:default:data', ...defaultIds);
    }
    if (fallbackIds.length > 0) {
      pipeline2.hmget('summary:fallback:data', ...fallbackIds);
    }
    
    const amountResults = await pipeline2.exec();
    
    let defaultAmounts = [];
    let fallbackAmounts = [];
    
    if (amountResults) {
      if (defaultIds.length > 0) {
        defaultAmounts = (amountResults[0]?.[1] || []).map(a => parseFloat(a) || 0);
      }
      if (fallbackIds.length > 0) {
        const idx = defaultIds.length > 0 ? 1 : 0;
        fallbackAmounts = (amountResults[idx]?.[1] || []).map(a => parseFloat(a) || 0);
      }
    }
    
    return {
      default: {
        totalRequests: defaultAmounts.length,
        totalAmount: round2(defaultAmounts.reduce((sum, amount) => sum + amount, 0))
      },
      fallback: {
        totalRequests: fallbackAmounts.length,
        totalAmount: round2(fallbackAmounts.reduce((sum, amount) => sum + amount, 0))
      }
    };
    
  } catch (error) {
    console.error('Error getting payments summary:', error);
    return {
      default: { totalRequests: 0, totalAmount: 0 },
      fallback: { totalRequests: 0, totalAmount: 0 }
    };
  }
}

module.exports = {
  getPaymentsSummary,
};