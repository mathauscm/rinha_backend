// Estado em memória simples - muito mais rápido que Redis
class PaymentStorage {
  constructor() {
    this.payments = [];
    this.processedIds = new Set(); // Controle de duplicatas
  }

  push(amount, timestamp, correlationId) {
    // Evita duplicatas
    if (this.processedIds.has(correlationId)) {
      return false;
    }
    
    this.processedIds.add(correlationId);
    this.payments.push({ amount, timestamp });
    return true;
  }

  list() {
    return this.payments;
  }

  clear() {
    this.payments = [];
    this.processedIds.clear();
  }
}

const state = {
  default: new PaymentStorage(),
  fallback: new PaymentStorage()
};

module.exports = { state, PaymentStorage };