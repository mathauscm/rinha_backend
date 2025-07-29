const redisClient = require('../cache/redisClient');
const { storeSummaryAtomic } = require('../redis-scripts');
const { decode } = require('@msgpack/msgpack');
const { Pool } = require('undici');

// HTTP pools para os Payment Processors REAIS
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 20,
  pipelining: 5,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 600000,
  headersTimeout: 2000,
  bodyTimeout: 2000
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 20,
  pipelining: 5,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 600000,
  headersTimeout: 2000,
  bodyTimeout: 2000
});

// Health check cache (respeitando limite de 1 call per 5s)
const healthCache = {
  default: { lastCheck: 0, isHealthy: true, minResponseTime: 100 },
  fallback: { lastCheck: 0, isHealthy: true, minResponseTime: 200 }
};

const HEALTH_CHECK_INTERVAL = 5000; // 5 segundos conforme spec

async function checkHealth(processor, pool) {
  const now = Date.now();
  const cache = healthCache[processor];
  
  // Respeta rate limit de 5 segundos
  if (now - cache.lastCheck < HEALTH_CHECK_INTERVAL) {
    return cache.isHealthy;
  }
  
  try {
    const response = await pool.request({
      path: '/payments/service-health',
      method: 'GET',
      headersTimeout: 1000,
      bodyTimeout: 1000
    });
    
    const healthData = await response.body.json();
    cache.isHealthy = !healthData.failing;
    cache.minResponseTime = healthData.minResponseTime || 100;
    cache.lastCheck = now;
    
    console.log(`Health check ${processor}: healthy=${cache.isHealthy}, minTime=${cache.minResponseTime}ms`);
    return cache.isHealthy;
    
  } catch (err) {
    console.log(`Health check ${processor} failed:`, err.message);
    cache.isHealthy = false;
    cache.lastCheck = now;
    return false;
  }
}

async function postToProcessor(pool, paymentData) {
  const body = JSON.stringify({
    correlationId: paymentData.correlationId,
    amount: paymentData.amount,
    requestedAt: paymentData.requestedAt
  });

  const response = await pool.request({
    path: '/payments',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body,
    headersTimeout: 3000,
    bodyTimeout: 3000
  });

  if (response.statusCode >= 400) {
    throw new Error(`HTTP ${response.statusCode}: ${await response.body.text()}`);
  }

  return await response.body.text();
}

async function processPaymentReal(correlationId, paymentData) {
  console.log(`DEBUG: Processing real payment ${correlationId} amount=${paymentData.amount}`);
  
  // Verifica health dos processadores
  const defaultHealthy = await checkHealth('default', defaultPool);
  const fallbackHealthy = await checkHealth('fallback', fallbackPool);
  
  let success = false;
  let targetHost = null;
  let lastError = null;

  // Estratégia: Sempre prefere default (menor taxa) se estiver saudável
  if (defaultHealthy) {
    try {
      console.log(`DEBUG: Trying default processor for ${correlationId}`);
      await postToProcessor(defaultPool, paymentData);
      success = true;
      targetHost = 'default';
      console.log(`DEBUG: Default processor SUCCESS for ${correlationId}`);
    } catch (err) {
      console.log(`DEBUG: Default processor FAILED for ${correlationId}:`, err.message);
      lastError = err;
      // Marca como não saudável temporariamente
      healthCache.default.isHealthy = false;
    }
  }

  // Se default falhou ou não estava saudável, tenta fallback
  if (!success && fallbackHealthy) {
    try {
      console.log(`DEBUG: Trying fallback processor for ${correlationId}`);
      await postToProcessor(fallbackPool, paymentData);
      success = true;
      targetHost = 'fallback';
      console.log(`DEBUG: Fallback processor SUCCESS for ${correlationId}`);
    } catch (err) {
      console.log(`DEBUG: Fallback processor FAILED for ${correlationId}:`, err.message);
      lastError = err;
      healthCache.fallback.isHealthy = false;
    }
  }

  // Se ambos falharam mas estavam "saudáveis", força retry no default (menor taxa)
  if (!success && (defaultHealthy || fallbackHealthy)) {
    try {
      console.log(`DEBUG: Force retry on default for ${correlationId}`);
      await postToProcessor(defaultPool, paymentData);
      success = true;
      targetHost = 'default';
      console.log(`DEBUG: Force retry SUCCESS for ${correlationId}`);
    } catch (err) {
      console.log(`DEBUG: Force retry FAILED for ${correlationId}:`, err.message);
      lastError = err;
    }
  }

  return { success, targetHost, error: lastError };
}

async function workerLoop(workerId = 0) {
  console.log(`Real payment processor worker ${workerId} started`);
  
  // Aguarda inicialização do Redis
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  while (true) {
    try {
      // Busca 1 pagamento por vez para evitar sobrecarga
      const res = await redisClient.brpop('payments:queue', 1);
      if (!res) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      
      const correlationId = res[1];
      console.log(`DEBUG: Worker ${workerId} processing payment: ${correlationId}`);
      
      // Busca dados do pagamento
      const paymentDataJson = await redisClient.hget('payments:processing', correlationId);
      if (!paymentDataJson) {
        console.log(`DEBUG: No payment data found for ${correlationId}, skipping`);
        continue;
      }
      
      let paymentData;
      try {
        // Decodifica dados do MessagePack base64
        paymentData = decode(Buffer.from(paymentDataJson, 'base64'));
        console.log(`DEBUG: Decoded payment data for ${correlationId}:`, paymentData);
      } catch (decodeErr) {
        console.log(`DEBUG: Failed to decode payment data for ${correlationId}:`, decodeErr.message);
        await redisClient.hdel('payments:processing', correlationId);
        continue;
      }
      
      // PROCESSA PAGAMENTO REAL (não mock!)
      const { success, targetHost, error } = await processPaymentReal(correlationId, paymentData);

      if (success && targetHost) {
        try {
          // Armazena summary APENAS se processamento foi bem-sucedido
          const timestampMs = new Date(paymentData.requestedAt).getTime();
          await storeSummaryAtomic(targetHost, correlationId, paymentData.amount, timestampMs);
          console.log(`DEBUG: Payment ${correlationId} stored successfully to ${targetHost} summary`);
          
          // Remove da fila de processamento
          await redisClient.hdel('payments:processing', correlationId);
          
        } catch (storeErr) {
          console.log(`DEBUG: Failed to store summary for ${correlationId}:`, storeErr.message);
          // Recoloca na queue para retry
          await redisClient.lpush('payments:queue', correlationId);
        }
      } else {
        console.log(`DEBUG: Payment ${correlationId} processing failed completely:`, error?.message);
        
        // ESTRATÉGIA DE RETRY: Recoloca na queue com limite
        const retryCount = await redisClient.hincrby('payments:retries', correlationId, 1);
        
        if (retryCount <= 3) {
          console.log(`DEBUG: Requeueing ${correlationId} for retry ${retryCount}/3`);
          // Delay progressivo: 1s, 2s, 4s
          await new Promise(r => setTimeout(r, retryCount * 1000));
          await redisClient.lpush('payments:queue', correlationId);
        } else {
          console.log(`DEBUG: Payment ${correlationId} exceeded retry limit, giving up`);
          await redisClient.hdel('payments:processing', correlationId);
          await redisClient.hdel('payments:retries', correlationId);
        }
      }
      
    } catch (err) {
      console.error(`Worker ${workerId} error:`, err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down worker pools...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down worker pools...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

// Single worker
if (require.main === module) {
  console.log('Starting real payment processor worker');
  workerLoop(1).catch(console.error);
}

module.exports = { workerLoop };