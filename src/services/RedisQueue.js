const { Worker } = require('worker_threads');
const path = require('path');
const { floatToCents } = require('../shared');
const { redis } = require('../state/redisState');

class RedisQueue {
  constructor(state, options = {}) {
    this.state = state;
    this.workersFns = [];
    this.workersIdle = [];
    this.processing = new Set();
    
    const workerCount = options.workers || 3;
    const workerPath = path.resolve(__dirname, '../workers/payment.js');
    
    // Criar workers
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerPath);
      this.workersIdle.push(i);
      this.workersFns.push((message) => worker.postMessage(message));
      
      worker.on('message', (message) => this.onWorkerMessage(i, message));
    }
    
    // Inicia processamento contínuo da fila Redis
    this.startProcessing();
  }

  async enqueue(message) {
    // Adiciona na fila Redis compartilhada se não está sendo processado
    const isNew = await redis.sadd('payments:processing', message.correlationId);
    
    if (isNew === 1) {
      // Novo pagamento - adiciona na fila
      await redis.lpush('payments:queue', JSON.stringify(message));
      return true;
    }
    
    return false; // Já estava sendo processado
  }

  async startProcessing() {
    while (true) {
      try {
        if (this.hasWorkersIdle()) {
          // Pega próximo item da fila Redis (bloqueante por 1 segundo)
          const result = await redis.brpop('payments:queue', 1);
          
          if (result) {
            const [, messageStr] = result;
            const message = JSON.parse(messageStr);
            
            const workerIndex = this.workersIdle.pop();
            if (workerIndex !== undefined) {
              this.workersFns[workerIndex](message);
            } else {
              // Recoloca na fila se não há worker disponível
              await redis.lpush('payments:queue', messageStr);
            }
          }
        } else {
          // Espera um pouco se não há workers idle
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  hasWorkersIdle() {
    return this.workersIdle.length > 0;
  }

  async onWorkerMessage(workerIndex, message) {
    const { state, payload } = message;
    
    switch (state) {
      case 'fulfilled':
        await this.setResultState(payload);
        // Remove do processamento após sucesso
        await redis.srem('payments:processing', payload.correlationId);
        break;
      case 'rejected':
        // Remove do processamento para permitir retry
        await redis.srem('payments:processing', payload.correlationId);
        // Requeue se não excedeu tentativas
        const retryCount = await redis.incr(`retries:${payload.correlationId}`);
        if (retryCount <= 3) {
          await redis.lpush('payments:queue', JSON.stringify(payload));
        } else {
          // Remove contador de retry após esgotar tentativas
          await redis.del(`retries:${payload.correlationId}`);
        }
        break;
    }
    
    this.workersIdle.push(workerIndex);
  }

  async setResultState(message) {
    const amount = floatToCents(message.amount);
    const timestamp = new Date(message.requestedAt).getTime();
    
    switch (message.paymentProcessor) {
      case 'default':
        await this.state.default.push(amount, timestamp, message.correlationId);
        break;
      case 'fallback':
        await this.state.fallback.push(amount, timestamp, message.correlationId);
        break;
    }
  }
}

module.exports = { RedisQueue };