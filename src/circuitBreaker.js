class SimpleCircuitBreaker {
  constructor(failureThreshold = 5, timeout = 5000) {
    this.failureThreshold = failureThreshold;
    this.timeout = timeout;
    this.failures = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = 0;
    this.lastFailure = 0;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker is OPEN for ${this.timeout}ms`);
      }
      // Tenta half-open
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
  
  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      nextAttempt: this.nextAttempt,
      isOpen: this.state === 'OPEN'
    };
  }
  
  reset() {
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = 0;
  }
}

module.exports = SimpleCircuitBreaker;