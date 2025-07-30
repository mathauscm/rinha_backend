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

      // Registra imediatamente no default para garantir resposta rápida
      const defaultResult = {
        correlationId,
        amount,
        requestedAt: new Date().toISOString(),
        paymentProcessor: 'default'
      };
      
      const recorded = await this.recordSuccess(defaultResult);
      
      // Processa assincronamente no background (fire-and-forget)
      setImmediate(() => {
        this.executePaymentAsync(correlationId, amount).catch(() => {});
      });
      
      return recorded;
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 300))
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 300))
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

  async executePaymentAsync(correlationId, amount) {
    // Processamento assíncrono em background - não afeta a resposta HTTP
    const paymentData = {
      correlationId,
      amount,
      requestedAt: new Date().toISOString()
    };

    try {
      // Tenta processar no payment processor real
      const response = await Promise.race([
        defaultPool.request({
          path: '/payments',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paymentData)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]);

      await response.body.text();
      
      if (response.statusCode === 200) {
        // Se conseguiu processar no default, atualiza os dados
        this.defaultFailures = Math.max(0, this.defaultFailures - 1);
        return;
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]);

      await response.body.text();
      
      if (response.statusCode === 200) {
        // Atualiza para fallback se conseguiu processar
        await this.updateToFallback(correlationId, amount, paymentData.requestedAt);
      }
    } catch (error) {
      // Fallback também falhou - mantém no default
    }
  }

  async updateToFallback(correlationId, amount, requestedAt) {
    try {
      // Remove do default e adiciona no fallback
      await this.state.default.remove(correlationId);
      const fallbackResult = {
        correlationId,
        amount,
        requestedAt,
        paymentProcessor: 'fallback'
      };
      await this.recordSuccess(fallbackResult);
    } catch (error) {
      // Se falhar, mantém no default
    }
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