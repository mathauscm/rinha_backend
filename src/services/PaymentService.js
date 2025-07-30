const { Pool } = require('undici');
const { redis } = require('../state/redisState');
const { EventEmitter } = require('events');

// HTTP pools otimizados para os Payment Processors
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 20,
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 1000,
  headersTimeout: 500
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 20,
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
    
    // Queue-based architecture inspired by Rust implementation
    this.paymentQueue = [];
    this.isHealthy = false;
    this.isProcessing = false;
    this.workers = [];
    this.TRIGGER_THRESHOLD = 50; // 50ms threshold like Rust TRIGGER
    this.MAX_WORKERS = 4;
    
    // Initialize dispatcher and workers
    this.initializeDispatcher();
    this.initializeWorkers();
  }

  async processPayment(correlationId, amount) {
    // Queue-based approach: just submit to queue and return immediately
    const paymentData = {
      correlationId,
      amount,
      timestamp: Date.now()
    };
    
    this.paymentQueue.push(paymentData);
    return true;
  }



  initializeDispatcher() {
    // Single dispatcher that processes queue when healthy=false or as fallback
    setInterval(async () => {
      if (this.paymentQueue.length > 0 && !this.isProcessing) {
        const paymentData = this.paymentQueue.shift();
        if (paymentData) {
          await this.processPaymentSync(paymentData);
        }
      }
    }, 10); // Very fast polling
  }
  
  initializeWorkers() {
    // Workers activate when healthy=true for parallel processing
    for (let i = 0; i < this.MAX_WORKERS; i++) {
      setInterval(async () => {
        if (this.isHealthy && this.paymentQueue.length > 0) {
          const paymentData = this.paymentQueue.shift();
          if (paymentData) {
            const start = Date.now();
            const success = await this.processPaymentSync(paymentData);
            const duration = Date.now() - start;
            
            // If slow or failed, disable workers (back to dispatcher)
            if (!success || duration > this.TRIGGER_THRESHOLD) {
              this.isHealthy = false;
            }
          }
        }
      }, 5); // Even faster for workers
    }
  }
  
  async processPaymentSync(paymentData) {
    const requestData = {
      correlationId: paymentData.correlationId,
      amount: paymentData.amount,
      requestedAt: new Date(paymentData.timestamp).toISOString()
    };

    const start = Date.now();
    
    try {
      const response = await Promise.race([
        defaultPool.request({
          path: '/payments',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestData)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 300))
      ]);

      await response.body.text();
      
      if (response.statusCode === 200) {
        const duration = Date.now() - start;
        
        // If fast, enable workers for parallel processing
        if (duration <= this.TRIGGER_THRESHOLD) {
          this.isHealthy = true;
          // Drain queue to workers
          this.emit('drain-queue');
        }
        
        await this.recordSuccess({
          ...requestData,
          paymentProcessor: 'default'
        });
        
        return true;
      }
    } catch (error) {
      // If failed, put back in queue for retry
      this.paymentQueue.unshift(paymentData);
      this.isHealthy = false;
    }
    
    return false;
  }


  getQueueSize() {
    return this.paymentQueue.length;
  }
  
  isSystemHealthy() {
    return this.isHealthy;
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

  async getHealthStatus(processor) {
    const now = Date.now();
    const cache = processor === 'default' ? this.defaultHealthCache : this.fallbackHealthCache;
    
    // Usa cache se ainda válido (respeitando limite de 5s)
    if ((now - cache.lastCheck) < this.HEALTH_CACHE_TTL) {
      return cache;
    }

    try {
      const pool = processor === 'default' ? defaultPool : fallbackPool;
      const response = await Promise.race([
        pool.request({
          path: '/payments/service-health',
          method: 'GET'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 1000))
      ]);

      const body = await response.body.json();
      
      if (response.statusCode === 200) {
        cache.failing = body.failing || false;
        cache.minResponseTime = body.minResponseTime || 100;
        cache.lastCheck = now;
      }
    } catch (error) {
      // Se health-check falhou, assume que está funcionando (fallback conservador)
      cache.failing = false;
      cache.minResponseTime = 100;
      cache.lastCheck = now;
    }

    return cache;
  }

}

module.exports = { PaymentService };