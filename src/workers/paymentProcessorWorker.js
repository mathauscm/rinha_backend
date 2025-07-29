const redisClient = require('../cache/redisClient');
const http = require('http');
const { Pool } = require('pg');

// Pool dedicado para o worker
const pool = new Pool({
  host: 'postgres',
  port: 5432,
  user: 'rinha',
  password: 'rinha123',
  database: 'rinhadb',
  max: 10,
  min: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 1000,
  acquireTimeoutMillis: 500,
  statement_timeout: 100,
  query_timeout: 100,
});

const PAYMENT_PROCESSOR_DEFAULT = 'payment-processor-default';
const PAYMENT_PROCESSOR_FALLBACK = 'payment-processor-fallback';

async function processPayment(correlationId, paymentData) {
  let targetHost = PAYMENT_PROCESSOR_DEFAULT;
  let success = false;
  let lastError = null;

  try {
    // Tenta enviar para default
    await postPayment(targetHost, correlationId, paymentData);
    success = true;
  } catch (err) {
    lastError = err;
    // Tenta fallback
    targetHost = PAYMENT_PROCESSOR_FALLBACK;
    try {
      await postPayment(targetHost, correlationId, paymentData);
      success = true;
    } catch (err2) {
      lastError = err2;
    }
  }

  return { success, targetHost, error: lastError };
}

function postPayment(hostname, correlationId, paymentData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      correlationId,
      amount: paymentData.amount,
      requestedAt: paymentData.requestedAt,
    });

    const options = {
      hostname,
      port: 8080,
      path: '/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 3000, // 3 segundos timeout
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`Payment failed with status ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(data);
    req.end();
  });
}

async function savePaymentToDB(correlationId, amount, requestedAt, targetHost) {
  const client = await pool.connect();
  try {
    const paymentProcessor = targetHost === PAYMENT_PROCESSOR_DEFAULT ? 'default' : 'fallback';
    await client.query(
      'INSERT INTO payments(correlation_id, amount, requested_at, payment_processor) VALUES ($1, $2, $3, $4)',
      [correlationId, amount, requestedAt, paymentProcessor]
    );
  } catch (err) {
    console.error('Error saving payment to DB:', err);
    // Não falha o worker por erro de DB
  } finally {
    client.release();
  }
}

async function workerLoop() {
  console.log('Payment processor worker started');
  
  while (true) {
    try {
      // Espera até ter algo na fila (bloqueante)
      const res = await redisClient.brpop('payments:queue', 0);
      if (!res) continue;
      
      const [, correlationId] = res;

      const paymentDataJson = await redisClient.hget('payments:processing', correlationId);
      if (!paymentDataJson) {
        console.warn(`No payment data for correlationId ${correlationId}`);
        continue;
      }
      
      const paymentData = JSON.parse(paymentDataJson);

      const { success, targetHost, error } = await processPayment(correlationId, paymentData);

      if (success) {
        // Salva no banco e remove da fila de processamento
        await savePaymentToDB(correlationId, paymentData.amount, paymentData.requestedAt, targetHost);
        await redisClient.hdel('payments:processing', correlationId);
      } else {
        console.error(`Failed to process payment ${correlationId}:`, error?.message);
        // Remove da fila de processamento mesmo em caso de falha
        // para evitar loop infinito
        await redisClient.hdel('payments:processing', correlationId);
      }
    } catch (err) {
      console.error('Worker loop error:', err);
      // Pequena pausa antes de continuar para evitar loop agressivo
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Pool cleanup
process.on('SIGINT', async () => {
  console.log('Shutting down worker...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await pool.end();
  process.exit(0);
});

// Inicia o worker se executado diretamente
if (require.main === module) {
  workerLoop().catch(console.error);
}

module.exports = {
  workerLoop,
};