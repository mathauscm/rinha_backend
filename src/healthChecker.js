const healthChecker = {
  default: { 
    failing: false, 
    lastCheck: 0,
    minResponseTime: 100
  },
  fallback: { 
    failing: false, 
    lastCheck: 0,
    minResponseTime: 200
  }
};

// Rate limit: 1 call per 5 seconds (conforme especificação)
const HEALTH_CHECK_INTERVAL = 5000;

async function checkProcessorHealth(processor, pool) {
  const now = Date.now();
  const checker = healthChecker[processor];
  
  // Respeita rate limit de 5 segundos
  if (now - checker.lastCheck < HEALTH_CHECK_INTERVAL) {
    return !checker.failing;
  }
  
  try {
    const response = await pool.request({
      path: '/payments/service-health',
      method: 'GET',
      headersTimeout: 1000,
      bodyTimeout: 1000
    });
    
    const healthData = await response.body.json();
    checker.failing = healthData.failing;
    checker.minResponseTime = healthData.minResponseTime;
    checker.lastCheck = now;
    
    return !healthData.failing;
  } catch (err) {
    // Se health check falhar, assume que está com problemas
    checker.failing = true;
    checker.lastCheck = now;
    return false;
  }
}

async function getOptimalProcessor(defaultPool, fallbackPool) {
  const defaultHealthy = await checkProcessorHealth('default', defaultPool);
  const fallbackHealthy = await checkProcessorHealth('fallback', fallbackPool);
  
  // Estratégia: Sempre prefere default se estiver saudável (menor taxa)
  if (defaultHealthy) {
    return { processor: 'default', pool: defaultPool };
  }
  
  if (fallbackHealthy) {
    return { processor: 'fallback', pool: fallbackPool };
  }
  
  // Se ambos falhando, tenta default mesmo assim (menor taxa = mais lucro)
  return { processor: 'default', pool: defaultPool };
}

function getHealthStatus() {
  return {
    default: {
      healthy: !healthChecker.default.failing,
      minResponseTime: healthChecker.default.minResponseTime,
      lastCheck: healthChecker.default.lastCheck
    },
    fallback: {
      healthy: !healthChecker.fallback.failing,
      minResponseTime: healthChecker.fallback.minResponseTime,
      lastCheck: healthChecker.fallback.lastCheck
    }
  };
}

module.exports = {
  checkProcessorHealth,
  getOptimalProcessor,
  getHealthStatus,
  healthChecker
};