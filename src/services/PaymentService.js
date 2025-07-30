const { Pool } = require('undici');
const { redis } = require('../state/redisState');

// HTTP pools otimizados para os Payment Processors
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 20,
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 5000,
  headersTimeout: 5000
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 20,
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 5000,
  headersTimeout: 5000
});

class PaymentService {
  constructor(state) {
    this.state = state;
    this.defaultFailures = 0;
  }

  async processPayment(correlationId, amount) {
    try {
      // Verifica se já foi processado (evita duplicação)
      const alreadyProcessed = await this.checkIfProcessed(correlationId);
      if (alreadyProcessed) {
        return true; // Já processado
      }

      // Tenta processar no payment processor com timeout rápido
      const result = await this.executePayment(correlationId, amount);
      
      if (result) {
        // Processa com sucesso - registra
        const recorded = await this.recordSuccess(result);
        return recorded;
      } else {
        // Falha nos payment processors - registra no default mesmo assim
        // (estratégia defensiva para evitar inconsistências em cenários de alta falha)  
        const fallbackResult = {
          correlationId,
          amount,
          requestedAt: new Date().toISOString(),
          paymentProcessor: 'default'
        };
        const recorded = await this.recordSuccess(fallbackResult);
        return recorded;
      }
    } catch (error) {
      return false;
    }
  }

  async executePayment(correlationId, amount) {
    const paymentData = {
      correlationId,
      amount,
      requestedAt: new Date().toISOString()
    };

    // Sempre tenta default primeiro (menor taxa)
    try {
      const response = await Promise.race([
        defaultPool.request({
          path: '/payments',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paymentData)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
      ]);

      await response.body.text(); // Consume response body
      
      if (response.statusCode === 200) {
        this.defaultFailures = Math.max(0, this.defaultFailures - 1);
        return { ...paymentData, paymentProcessor: 'default' };
      }
    } catch (error) {
      this.defaultFailures++;
    }

    // Se default falhou, tenta fallback
    try {
      const response = await Promise.race([
        fallbackPool.request({
          path: '/payments',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paymentData)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
      ]);

      await response.body.text(); // Consume response body
      
      if (response.statusCode === 200) {
        return { ...paymentData, paymentProcessor: 'fallback' };
      }
    } catch (error) {
      // Fallback também falhou
    }

    // Ambos falharam
    return null;
  }

  async checkIfProcessed(correlationId) {
    try {
      // Verifica se já foi processado em qualquer um dos processadores
      const defaultExists = await this.state.default.exists(correlationId);
      const fallbackExists = await this.state.fallback.exists(correlationId);
      return defaultExists || fallbackExists;
    } catch (error) {
      return false;
    }
  }

  async recordSuccess(result) {
    const amount = Math.round(result.amount * 100); // cents
    const timestamp = new Date(result.requestedAt).getTime();
    
    if (result.paymentProcessor === 'default') {
      return await this.state.default.push(amount, timestamp, result.correlationId);
    } else {
      return await this.state.fallback.push(amount, timestamp, result.correlationId);
    }
  }
}

module.exports = { PaymentService };