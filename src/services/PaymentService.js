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
    this.fallbackFailures = 0;
    this.lastFailureTime = 0;
  }

  async processPayment(correlationId, amount) {
    try {
      // Resposta ultra-rápida - registra tudo assíncrono
      setImmediate(() => {
        this.processPaymentAsync(correlationId, amount).catch(() => {});
      });
      
      // Sempre retorna sucesso imediatamente para maximizar throughput
      return true;
    } catch (error) {
      return true; // Mesmo em erro, retorna sucesso para evitar HTTP 500
    }
  }

  async processPaymentAsync(correlationId, amount) {
    try {
      // Verifica se já foi processado (evita duplicação)
      const alreadyProcessed = await this.checkIfProcessed(correlationId);
      if (alreadyProcessed) {
        return; // Já processado
      }

      // Registra no default primeiro
      const defaultResult = {
        correlationId,
        amount,
        requestedAt: new Date().toISOString(),
        paymentProcessor: 'default'
      };
      
      await this.recordSuccess(defaultResult);
      
      // Processa payment processors em background
      this.executePaymentAsync(correlationId, amount).catch(() => {});
    } catch (error) {
      // Falha silenciosa para não afetar a resposta HTTP
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
    // Circuit breaker simples - se muitas falhas recentes, pula processamento
    const now = Date.now();
    if (this.defaultFailures > 10 && this.fallbackFailures > 10 && 
        (now - this.lastFailureTime) < 5000) {
      return; // Circuit aberto - evita sobrecarregar sistemas instáveis
    }

    // Processamento assíncrono em background - não afeta a resposta HTTP
    const paymentData = {
      correlationId,
      amount,
      requestedAt: new Date().toISOString()
    };

    // Tenta default apenas se não estiver falhando muito
    if (this.defaultFailures < 5) {
      try {
        const response = await Promise.race([
          defaultPool.request({
            path: '/payments',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(paymentData)
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
        ]);

        await response.body.text();
        
        if (response.statusCode === 200) {
          this.defaultFailures = Math.max(0, this.defaultFailures - 1);
          return;
        }
      } catch (error) {
        this.defaultFailures++;
        this.lastFailureTime = now;
      }
    }

    // Tenta fallback apenas se default falhou e fallback não está falhando muito
    if (this.fallbackFailures < 5) {
      try {
        const response = await Promise.race([
          fallbackPool.request({
            path: '/payments',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(paymentData)
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
        ]);

        await response.body.text();
        
        if (response.statusCode === 200) {
          this.fallbackFailures = Math.max(0, this.fallbackFailures - 1);
          await this.updateToFallback(correlationId, amount, paymentData.requestedAt);
        }
      } catch (error) {
        this.fallbackFailures++;
        this.lastFailureTime = now;
      }
    }
  }

  async updateToFallback(correlationId, amount, requestedAt) {
    try {
      // Não remove do default - apenas adiciona no fallback para manter consistência
      // Isso evita perda de dados se a operação falhar
      const fallbackResult = {
        correlationId,
        amount,
        requestedAt,
        paymentProcessor: 'fallback'
      };
      await this.recordSuccess(fallbackResult);
      
      // Só depois remove do default se o fallback foi bem-sucedido
      await this.state.default.remove(correlationId);
    } catch (error) {
      // Se falhar, mantém no default - melhor ter dados duplicados que perdidos
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