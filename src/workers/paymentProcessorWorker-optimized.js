const redisClient = require('../cache/redisClient');
const { storeSummaryAtomic } = require('../redis-scripts');
const { Pool } = require('undici');
const { decode } = require('@msgpack/msgpack');
const cluster = require('cluster');
const os = require('os');

// Pools HTTP ultra-otimizados
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 100,
  pipelining: 20,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000,
  headersTimeout: 300,
  bodyTimeout: 300
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 100,
  pipelining: 20,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000,
  headersTimeout: 300,
  bodyTimeout: 300
});

// Buffer pool para reutilizar objetos
const requestBodyPool = [];
function getRequestBody() {
  return requestBodyPool.pop() || {};
}
function returnRequestBody(obj) {
  for (const key in obj) delete obj[key];
  if (requestBodyPool.length < 500) requestBodyPool.push(obj);
}

async function postPayment(pool, correlationId, paymentData) {
  const body = getRequestBody();
  body.correlationId = correlationId;
  body.amount = paymentData.amount;
  body.requestedAt = paymentData.requestedAt;
  
  const bodyStr = JSON.stringify(body);
  returnRequestBody(body);

  const response = await pool.request({
    path: '/payments',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyStr,
    throwOnError: true,
    headersTimeout: 200,
    bodyTimeout: 200,
  });

  return response.body.text();
}

async function processPayment(correlationId, paymentData) {
  let targetHost = 'default';
  let success = false;
  let retries = 0;
  const maxRetries = 2; // Reduzido para ser mais agressivo

  // Tenta default com retry mínimo
  while (retries < maxRetries && !success) {
    try {
      await postPayment(defaultPool, correlationId, paymentData);
      success = true;
      break;
    } catch (err) {
      retries++;
      if (retries < maxRetries) {
        await new Promise(r => setTimeout(r, 50)); // 50ms retry
      }
    }
  }

  // Fallback se necessário
  if (!success) {
    targetHost = 'fallback';
    try {
      await postPayment(fallbackPool, correlationId, paymentData);
      success = true;
    } catch (err) {
      // Ignora erro - will be handled upstream
    }
  }

  return { success, targetHost };
}

async function workerLoop(workerId = 0) {
  console.log(`Optimized worker ${workerId} started`);
  
  const batchSize = 20; // Aumentado para maior throughput
  
  while (true) {
    try {
      const batch = [];
      
      // Busca lote maior
      for (let i = 0; i < batchSize; i++) {
        const res = await redisClient.brpop('payments:queue', i === 0 ? 0 : 0.001);
        if (!res) break;
        batch.push(res[1]);
      }
      
      if (batch.length === 0) continue;
      
      // Pipeline para buscar dados
      const pipeline = redisClient.pipeline();
      batch.forEach(id => pipeline.hget('payments:processing', id));
      const paymentDataResults = await pipeline.exec();
      
      // Processa todos em paralelo
      const promises = batch.map(async (correlationId, index) => {
        try {
          const paymentDataJson = paymentDataResults[index][1];
          if (!paymentDataJson) return;
          
          const paymentData = decode(Buffer.from(paymentDataJson));
          const { success, targetHost } = await processPayment(correlationId, paymentData);

          if (success) {
            const timestampMs = new Date(paymentData.requestedAt).getTime();
            await storeSummaryAtomic(targetHost, correlationId, paymentData.amount, timestampMs);
          } else {
            // Remove mesmo se falhou para evitar reprocessamento infinito
            await redisClient.hdel('payments:processing', correlationId);
          }
          
        } catch (err) {
          await redisClient.hdel('payments:processing', correlationId);
        }
      });
      
      await Promise.all(promises);
      
    } catch (err) {
      console.error('Worker error:', err);
      await new Promise(r => setTimeout(r, 50)); // Pausa menor
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down optimized worker...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down optimized worker...');
  await defaultPool.close();
  await fallbackPool.close();
  process.exit(0);
});

// Cluster otimizado
if (require.main === module) {
  if (cluster.isPrimary) {
    const numWorkers = Math.min(os.cpus().length * 2, 16); // Mais workers
    console.log(`Starting ${numWorkers} optimized workers`);
    
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

module.exports = { workerLoop };