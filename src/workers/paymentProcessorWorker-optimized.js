const redisClient = require('../cache/redisClient');
const { storeSummaryAtomic } = require('../redis-scripts');
const { decode } = require('@msgpack/msgpack');
// const cluster = require('cluster'); // Removido para simplificar

// MOCK: Simulação simples para testes

// Simulação ultra-simples

async function smartProcessPayment(correlationId, paymentData) {
  // MOCK: Simula distribuição 80/20 entre default/fallback
  const processor = Math.random() < 0.8 ? 'default' : 'fallback';
  
  // MOCK: Simula processamento sempre bem-sucedido para testes
  await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5)); // 5-15ms delay
  
  return { success: true, targetHost: processor };
}

async function workerLoop(workerId = 0) {
  console.log(`Optimized worker ${workerId} started`);
  
  while (true) {
    try {
      // Busca apenas 1 item por vez para reduzir carga
      const res = await redisClient.brpop('payments:queue', 1);
      if (!res) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      
      const correlationId = res[1];
      console.log('DEBUG: Processing payment:', correlationId);
      
      // Busca dados do pagamento
      const paymentDataJson = await redisClient.hget('payments:processing', correlationId);
      if (!paymentDataJson) {
        console.log(`DEBUG: No payment data found for ${correlationId}`);
        continue;
      }
      
      console.log(`DEBUG: About to process ${correlationId}`);
      
      let paymentData, success, targetHost;
      
      // Decodifica dados do base64
      try {
        paymentData = decode(Buffer.from(paymentDataJson, 'base64'));
        console.log(`DEBUG: Decoded payment data successfully for ${correlationId}:`, paymentData);
      } catch (decodeErr) {
        console.log(`DEBUG: Failed to decode payment data for ${correlationId}:`, decodeErr.message);
        await redisClient.hdel('payments:processing', correlationId);
        continue;
      }
      
      // Processa pagamento
      try {
        const result = await smartProcessPayment(correlationId, paymentData);
        success = result.success;
        targetHost = result.targetHost;
        console.log(`DEBUG: smartProcessPayment result for ${correlationId}:`, { success, targetHost });
      } catch (processErr) {
        console.log(`DEBUG: Failed to process payment ${correlationId}:`, processErr.message);
        await redisClient.hdel('payments:processing', correlationId);
        continue;
      }

      if (success) {
        try {
          const timestampMs = new Date(paymentData.requestedAt).getTime();
          await storeSummaryAtomic(targetHost, correlationId, paymentData.amount, timestampMs);
          console.log(`DEBUG: Payment stored successfully to ${targetHost}:`, correlationId, paymentData.amount);
        } catch (storeErr) {
          console.log(`DEBUG: Store failed, requeueing payment:`, correlationId, storeErr.message);
          // RETRY: Recoloca na queue como a solução Java
          await redisClient.lpush('payments:queue', correlationId);
        }
      } else {
        console.log(`DEBUG: Processing failed, requeueing payment:`, correlationId);
        // RETRY: Recoloca na queue em caso de falha
        await redisClient.lpush('payments:queue', correlationId);
      }
      
    } catch (err) {
      console.error('Worker error:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down optimized worker...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down optimized worker...');
  process.exit(0);
});

// Single worker sem cluster para simplicidade
if (require.main === module) {
  console.log('Starting single optimized worker');
  setTimeout(() => {
    workerLoop(1).catch(console.error);
  }, 2000); // Delay para aguardar Redis
}

module.exports = { workerLoop };