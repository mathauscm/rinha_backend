const { Pool } = require('undici');

const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 10,
  pipelining: 1,
  keepAliveTimeout: 30000,
  bodyTimeout: 10000,
  headersTimeout: 5000
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 10,
  pipelining: 1,
  keepAliveTimeout: 30000,
  bodyTimeout: 10000,
  headersTimeout: 5000
});

class PaymentService {
  constructor(state) {
    this.state = state;
    this.queue = [];
    this.processing = false;
    this.processedCount = 0;
    
    this.startProcessor();
  }

  async processPayment(correlationId, amount) {
    this.queue.push({
      correlationId,
      amount,
      timestamp: Date.now()
    });
    
    return true;
  }

  startProcessor() {
    setInterval(async () => {
      if (this.processing || this.queue.length === 0) return;
      
      this.processing = true;
      const batch = this.queue.splice(0, 20);
      
      for (const payment of batch) {
        this.processPaymentSync(payment);
      }
      
      this.processing = false;
    }, 1);
  }

  async processPaymentSync(paymentData) {
    const requestBody = {
      correlationId: paymentData.correlationId,
      amount: paymentData.amount,
      requestedAt: new Date(paymentData.timestamp).toISOString()
    };

    // Try default first
    if (await this.tryProcessor(defaultPool, requestBody, 'default')) {
      this.processedCount++;
      return true;
    }

    // Try fallback
    if (await this.tryProcessor(fallbackPool, requestBody, 'fallback')) {
      this.processedCount++;
      return true;
    }

    // Retry once
    this.queue.unshift(paymentData);
    return false;
  }

  async tryProcessor(pool, requestData, processorType) {
    try {
      const response = await pool.request({
        path: '/payments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      });

      await response.body.text();

      if (response.statusCode === 200) {
        // Record in state
        const success = await this.state[processorType].push(
          Math.round(requestData.amount * 100), // cents
          new Date(requestData.requestedAt).getTime(),
          requestData.correlationId
        );
        
        return true;
      }
    } catch (error) {
      // Silent fail for performance
    }
    
    return false;
  }

  getQueueSize() {
    return this.queue.length;
  }

  getProcessedCount() {
    return this.processedCount;
  }
}

module.exports = { PaymentService };