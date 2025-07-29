const redisClient = require('../cache/redisClient');
const { Pool } = require('undici');
const cluster = require('cluster');
const os = require('os');

// HTTP pools otimizados
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 50,
  pipelining: 10,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 600000
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 50,
  pipelining: 10,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 600000
});

const PAYMENT_PROCESSOR_DEFAULT = 'default';
const PAYMENT_PROCESSOR_FALLBACK = 'fallback';

async function processPayment(correlationId, paymentData) {
  let targetHost = PAYMENT_PROCESSOR_DEFAULT;
  let success = false;
  let lastError = null;
  let retries = 0;
  const maxRetries = 3;

  // Tenta default com retry
  while (retries < maxRetries && !success) {
    try {
      await postPayment(defaultPool, correlationId, paymentData);
      success = true;
      break;
    } catch (err) {
      lastError = err;
      retries++;
      if (retries < maxRetries) {
        await new Promise(r => setTimeout(r, 100)); // 100ms retry delay
      }
    }
  }

  // Se falhou, tenta fallback
  if (!success) {
    targetHost = PAYMENT_PROCESSOR_FALLBACK;
    try {
      await postPayment(fallbackPool, correlationId, paymentData);
      success = true;
    } catch (err2) {
      lastError = err2;
    }
  }

  return { success, targetHost, error: lastError };
}

async function postPayment(pool, correlationId, paymentData) {
  const body = JSON.stringify({
    correlationId,
    amount: paymentData.amount,
    requestedAt: paymentData.requestedAt,
  });

  const response = await pool.request({
    path: '/payments',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    throwOnError: true,
    headersTimeout: 500,
    bodyTimeout: 500,
  });

  return response.body.text();
}

async function storeSummary(correlationId, amount, requestedAt, targetHost) {
  const timestampMs = new Date(requestedAt).getTime();
  
  const pipeline = redisClient.pipeline();
  pipeline.hset(`summary:${targetHost}:data`, correlationId, amount);
  pipeline.zadd(`summary:${targetHost}:history`, timestampMs, correlationId);
  
  try {
    await pipeline.exec();
  } catch (err) {
    console.error('Error storing summary:', err);
  }
}

async function workerLoop(workerId = 0) {
  console.log(`Payment processor worker ${workerId} started`);
  
  while (true) {
    try {
      // Processa múltiplos pagamentos em lote
      const batch = [];
      
      // Pega até 10 pagamentos por vez
      for (let i = 0; i < 10; i++) {
        const res = await redisClient.brpop('payments:queue', i === 0 ? 0 : 0.01);
        if (!res) break;
        batch.push(res[1]);
      }
      
      if (batch.length === 0) continue;
      
      // Processa todos em paralelo
      await Promise.all(batch.map(async (correlationId) => {
        try {
          const paymentDataJson = await redisClient.hget('payments:processing', correlationId);
          if (!paymentDataJson) return;
          
          const paymentData = JSON.parse(paymentDataJson);
          const { success, targetHost, error } = await processPayment(correlationId, paymentData);

          if (success) {
            await storeSummary(correlationId, paymentData.amount, paymentData.requestedAt, targetHost);
          } else {
            console.error(`Failed to process payment ${correlationId}:`, error?.message);
          }
          
          await redisClient.hdel('payments:processing', correlationId);
        } catch (err) {
          console.error(`Error processing payment ${correlationId}:`, err);
          await redisClient.hdel('payments:processing', correlationId);
        }
      }));
      
    } catch (err) {
      console.error('Worker loop error:', err);
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

// Pool cleanup
process.on('SIGINT', async () => {
  console.log('Shutting down worker...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

// Cluster de workers
if (require.main === module) {
  if (cluster.isPrimary) {
    const numWorkers = Math.min(os.cpus().length, 8); // Máximo 8 workers
    console.log(`Starting ${numWorkers} workers`);
    
    for (let i = 0; i < numWorkers; i++) {
      cluster.fork();
    }
    
    cluster.on('exit', (worker) => {
      console.log(`Worker ${worker.process.pid} died, restarting...`);
      cluster.fork();
    });
  } else {
    workerLoop(cluster.worker.id).catch(console.error);
  }
}

module.exports = {
  workerLoop,
};