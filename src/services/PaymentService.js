const { Pool } = require('undici');
const { redis } = require('../state/redisState');
const { EventEmitter } = require('events');

// HTTP pools otimizados para os Payment Processors - INCREASED CONNECTIONS
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 40, // DOUBLED for higher throughput
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
  bodyTimeout: 1000,
  headersTimeout: 500
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 40, // Same as default for fallback scenarios
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
    
    // SMART HEALTH-CHECK based strategy
    this.paymentQueue = [];
    this.isHealthy = false;
    this.TRIGGER_THRESHOLD = 200; // Rust threshold
    this.isShuttingDown = false;
    this.processedCount = 0;
    this.lastHealthCheck = 0;
    this.healthCheckInterval = 5000; // 5 seconds as per instructions
    this.currentMinResponseTime = 100; // Default
    this.defaultProcessorFailing = false;
    this.fallbackProcessorFailing = false;
    this.processedIds = new Set(); // Avoid reprocessing same payments
    this.processingIds = new Set(); // Track currently processing payments to avoid duplicates
    
    // Smart dispatcher with health checks
    this.initializeSmartDispatcher();
    this.setupGracefulShutdown();
  }

  async processPayment(correlationId, amount) {
    // Just queue it and return immediately like Rust
    const paymentData = {
      correlationId,
      amount,
      timestamp: Date.now()
    };
    
    this.paymentQueue.push(paymentData);
    return true;
  }

  initializeSmartDispatcher() {
    // Ultra-fast simple dispatcher - back to basics
    setInterval(async () => {
      // Process queue with minimal overhead
      if (this.paymentQueue.length > 0 && !this.isShuttingDown) {
        // Simple batch processing without complex logic
        const SIMPLE_BATCH = 16; // Larger batches for higher throughput
        const promises = [];
        
        for (let i = 0; i < SIMPLE_BATCH && this.paymentQueue.length > 0; i++) {
          const paymentData = this.paymentQueue.shift();
          if (paymentData) {
            promises.push(this.processPaymentSync(paymentData));
          }
        }
        
        // Process batch in parallel using allSettled to avoid blocking
        if (promises.length > 0) {
          Promise.allSettled(promises); // Non-blocking, handles failures better
        }
      }
    }, 2); // Faster interval for maximum throughput
    
    // Separate health check timer to avoid blocking
    setInterval(async () => {
      this.checkProcessorHealthAsync();
    }, 5000); // Every 5 seconds, non-blocking
  }
  
  checkProcessorHealthAsync() {
    // Check both default and fallback processors health
    Promise.allSettled([
      defaultPool.request({
        path: '/payments/service-health',
        method: 'GET'
      }).then(async (response) => {
        const healthData = await response.body.json();
        this.defaultProcessorFailing = healthData.failing || false;
        this.currentMinResponseTime = healthData.minResponseTime || 100;
      }).catch(() => {
        this.defaultProcessorFailing = true; // Mark as failing if health check fails
      }),
      
      fallbackPool.request({
        path: '/payments/service-health',
        method: 'GET'
      }).then(async (response) => {
        const healthData = await response.body.json();
        this.fallbackProcessorFailing = healthData.failing || false;
      }).catch(() => {
        this.fallbackProcessorFailing = true; // Mark as failing if health check fails
      })
    ]);
  }

  // Removed complex drain logic - using simple batching in dispatcher

  async processPaymentSync(paymentData) {
    const correlationId = paymentData.correlationId;
    
    // Avoid reprocessing same payments
    if (this.processedIds.has(correlationId) || this.processingIds.has(correlationId)) {
      return true; // Already processed or being processed
    }
    
    // Mark as currently processing to prevent duplicates
    this.processingIds.add(correlationId);
    
    try {
      const requestData = {
        correlationId: correlationId,
        amount: paymentData.amount,
        requestedAt: new Date(paymentData.timestamp).toISOString()
      };

      // Try default processor first
      const defaultResult = await this.tryProcessor(defaultPool, requestData, 'default');
      if (defaultResult) {
        this.processedIds.add(correlationId);
        this.processedCount++;
        return true;
      }
      
      // If default fails, try fallback processor
      const fallbackResult = await this.tryProcessor(fallbackPool, requestData, 'fallback');
      if (fallbackResult) {
        this.processedIds.add(correlationId);
        this.processedCount++;
        return true;
      }
      
      // Both processors failed - queue for retry
      paymentData.retries = (paymentData.retries || 0) + 1;
      if (paymentData.retries < 3) {
        this.paymentQueue.unshift(paymentData);
      }
      
      this.isHealthy = false;
      return false;
    } finally {
      // Always remove from processing set when done
      this.processingIds.delete(correlationId);
    }
  }

  async tryProcessor(pool, requestData, processorType) {
    const start = Date.now();
    
    try {
      const response = await pool.request({
        path: '/payments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      });

      await response.body.text();
      
      if (response.statusCode === 200) {
        const duration = Date.now() - start;
        
        // Health check exactly like Rust
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