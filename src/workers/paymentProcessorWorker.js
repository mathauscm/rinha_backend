const redisClient = require('../cache/redisClient');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const PAYMENT_PROCESSOR_DEFAULT = 'http://payment-processor-default:8080';
const PAYMENT_PROCESSOR_FALLBACK = 'http://payment-processor-fallback:8080';

async function processPayment(correlationId, paymentData) {
  // Exemplo de escolha simples, priorizando default
  // Pode implementar estratégia de health-check e fallback real
  let target = PAYMENT_PROCESSOR_DEFAULT;
  let success = false;
  let lastError = null;

  try {
    // Tenta enviar para default
    await axios.post(`${target}/payments`, {
      correlationId,
      amount: paymentData.amount,
      requestedAt: paymentData.requestedAt,
    });
    success = true;
  } catch (err) {
    lastError = err;
    // Tenta fallback
    target = PAYMENT_PROCESSOR_FALLBACK;
    try {
      await axios.post(`${target}/payments`, {
        correlationId,
        amount: paymentData.amount,
        requestedAt: paymentData.requestedAt,
      });
      success = true;
    } catch (err2) {
      lastError = err2;
    }
  }

  return { success, target, error: lastError };
}

async function workerLoop() {
  while (true) {
    try {
      // Espera até ter algo na fila
      const res = await redisClient.brpop('payments:queue', 0);
      if (!res) continue;
      const [, correlationId] = res;

      const paymentDataJson = await redisClient.hget('payments:processing', correlationId);
      if (!paymentDataJson) {
        console.warn(`No payment data for correlationId ${correlationId}`);
        continue;
      }
      const paymentData = JSON.parse(paymentDataJson);

      const { success, target, error } = await processPayment(correlationId, paymentData);

      if (success) {
        // Atualiza banco e remove da fila de processamento
        // Aqui você pode adicionar a lógica para inserir no PostgreSQL (exemplo simplificado abaixo)
        await savePaymentToDB(correlationId, paymentData.amount, paymentData.requestedAt, target);

        await redisClient.hdel('payments:processing', correlationId);
      } else {
        console.error(`Failed to process payment ${correlationId}`, error);
        // Aqui pode implementar retry/backoff, ou mover para fila de erros
      }
    } catch (err) {
      console.error('Worker loop error:', err);
      // Pequena pausa antes de continuar para evitar loop agressivo em erro
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function savePaymentToDB(correlationId, amount, requestedAt, paymentProcessor) {
  const client = await require('../db').pool.connect();
  try {
    await client.query(
      'INSERT INTO payments(correlation_id, amount, requested_at, payment_processor) VALUES ($1, $2, $3, $4)',
      [correlationId, amount, requestedAt, paymentProcessor === PAYMENT_PROCESSOR_DEFAULT ? 'default' : 'fallback']
    );
  } catch (err) {
    console.error('Error saving payment to DB:', err);
  } finally {
    client.release();
  }
}

module.exports = {
  workerLoop,
};
