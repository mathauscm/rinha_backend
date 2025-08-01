const { Pool } = require('undici');
const { redis } = require('../state/redisState');
const { EventEmitter } = require('events');

// HTTP pools otimizados para os Payment Processors - CONEXÕES AUMENTADAS
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 40, // DOBRADAS para maior throughput
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 1000,
  headersTimeout: 500
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 40, // Mesmo valor do padrão para cenários de fallback
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 1000,
  headersTimeout: 500
});

class PaymentService extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
    
    // Estratégia baseada em HEALTH-CHECK inteligente
    this.paymentQueue = [];
    this.isHealthy = false;
    this.TRIGGER_THRESHOLD = 200; // Limite do Rust
    this.isShuttingDown = false;
    this.processedCount = 0;
    this.lastHealthCheck = 0;
    this.healthCheckInterval = 5000; // 5 seconds as per instructions
    this.currentMinResponseTime = 100; // Padrão
    this.defaultProcessorFailing = false;
    this.fallbackProcessorFailing = false;
    this.processedIds = new Set(); // Evita reprocessar os mesmos pagamentos
    this.processingIds = new Set(); // Rastreia pagamentos em processamento para evitar duplicatas
    
    // Dispatcher inteligente com verificações de saúde
    this.initializeSmartDispatcher();
    this.setupGracefulShutdown();
  }

  async processPayment(correlationId, amount) {
    // Apenas enfileira e retorna imediatamente como o Rust
    const paymentData = {
      correlationId,
      amount,
      timestamp: Date.now()
    };
    
    this.paymentQueue.push(paymentData);
    return true;
  }

  initializeSmartDispatcher() {
    // Dispatcher simples ultra-rápido - voltando ao básico
    setInterval(async () => {
      // Processa fila com overhead mínimo
      if (this.paymentQueue.length > 0 && !this.isShuttingDown) {
        // Processamento em lote simples sem lógica complexa
        const SIMPLE_BATCH = 16; // Lotes maiores para maior throughput
        const promises = [];
        
        for (let i = 0; i < SIMPLE_BATCH && this.paymentQueue.length > 0; i++) {
          const paymentData = this.paymentQueue.shift();
          if (paymentData) {
            promises.push(this.processPaymentSync(paymentData));
          }
        }
        
        // Processa lote em paralelo usando allSettled para evitar bloqueio
        if (promises.length > 0) {
          Promise.allSettled(promises); // Não-bloqueante, lida melhor com falhas
        }
      }
    }, 2); // Intervalo mais rápido para throughput máximo
    
    // Timer separado de verificação de saúde para evitar bloqueio
    setInterval(async () => {
      this.checkProcessorHealthAsync();
    }, 5000); // A cada 5 segundos, não-bloqueante
  }
  
  checkProcessorHealthAsync() {
    // Verifica a saúde dos processadores padrão e fallback
    Promise.allSettled([
      defaultPool.request({
        path: '/payments/service-health',
        method: 'GET'
      }).then(async (response) => {
        const healthData = await response.body.json();
        this.defaultProcessorFailing = healthData.failing || false;
        this.currentMinResponseTime = healthData.minResponseTime || 100;
      }).catch(() => {
        this.defaultProcessorFailing = true; // Marca como falhando se o health check falhar
      }),
      
      fallbackPool.request({
        path: '/payments/service-health',
        method: 'GET'
      }).then(async (response) => {
        const healthData = await response.body.json();
        this.fallbackProcessorFailing = healthData.failing || false;
      }).catch(() => {
        this.fallbackProcessorFailing = true; // Marca como falhando se o health check falhar
      })
    ]);
  }

  // Removida lógica complexa de drain - usando lote simples no dispatcher

  async processPaymentSync(paymentData) {
    const correlationId = paymentData.correlationId;
    
    // Evita reprocessar os mesmos pagamentos
    if (this.processedIds.has(correlationId) || this.processingIds.has(correlationId)) {
      return true; // Já processado ou sendo processado
    }
    
    // Marca como processando atualmente para prevenir duplicatas
    this.processingIds.add(correlationId);
    
    try {
      const requestData = {
        correlationId: correlationId,
        amount: paymentData.amount,
        requestedAt: new Date(paymentData.timestamp).toISOString()
      };

      // Tenta processador padrão primeiro
      const defaultResult = await this.tryProcessor(defaultPool, requestData, 'default');
      if (defaultResult) {
        this.processedIds.add(correlationId);
        this.processedCount++;
        return true;
      }
      
      // Se o padrão falhar, tenta processador fallback
      const fallbackResult = await this.tryProcessor(fallbackPool, requestData, 'fallback');
      if (fallbackResult) {
        this.processedIds.add(correlationId);
        this.processedCount++;
        return true;
      }
      
      // Ambos processadores falharam - enfileira para retry
      paymentData.retries = (paymentData.retries || 0) + 1;
      if (paymentData.retries < 3) {
        this.paymentQueue.unshift(paymentData);
      }
      
      this.isHealthy = false;
      return false;
    } finally {
      // Sempre remove do conjunto de processamento quando terminar
      this.processingIds.delete(correlationId);
    }
  }

  async tryProcessor(pool, requestData, processorType) {
    const start = Date.now();
    
    try {
      const response = await pool.request({
        path: '/payments',
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Rinha-Token': '123'
        },
        body: JSON.stringify(requestData)
      });

      await response.body.text();
      
      if (response.statusCode === 200) {
        const duration = Date.now() - start;
        
        // Health check exatamente como o Rust
        if (duration <= this.TRIGGER_THRESHOLD) {
          this.isHealthy = true;
        }
        
        await this.recordSuccess({
          ...requestData,
          paymentProcessor: processorType
        });
        
        return true;
      }
    } catch (error) {
      return false;
    }
    
    return false;
  }

  getQueueSize() {
    return this.paymentQueue.length;
  }
  
  isSystemHealthy() {
    return this.isHealthy;
  }
  
  getProcessedCount() {
    return this.processedCount;
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

  setupGracefulShutdown() {
    const shutdownHandler = async () => {
      console.log('PaymentService: Starting graceful shutdown...');
      this.isShuttingDown = true;
      await this.flushQueue();
      console.log(`PaymentService: Shutdown complete. Final queue size: ${this.paymentQueue.length}`);
    };
    
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
    process.on('exit', shutdownHandler);
  }
  
  async flushQueue() {
    console.log(`PaymentService: Flushing queue with ${this.paymentQueue.length} pending payments...`);
    
    const startTime = Date.now();
    const MAX_FLUSH_TIME = 5000;
    
    while (this.paymentQueue.length > 0 && (Date.now() - startTime) < MAX_FLUSH_TIME) {
      const paymentData = this.paymentQueue.shift();
      if (paymentData) {
        await this.processPaymentSync(paymentData);
      }
    }
    
    const remainingItems = this.paymentQueue.length;
    if (remainingItems > 0) {
      console.warn(`PaymentService: ${remainingItems} payments could not be flushed within timeout`);
    } else {
      console.log('PaymentService: All payments flushed successfully');
    }
  }
}

module.exports = { PaymentService };