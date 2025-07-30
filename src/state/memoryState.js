// Cache em memória ultra-rápido sem dependências externas
class MemoryPaymentStorage {
  constructor(prefix) {
    this.prefix = prefix;
    this.processed = new Set();
    this.totalRequests = 0;
    this.totalAmount = 0;
    this.payments = [];
  }

  exists(correlationId) {
    return this.processed.has(correlationId);
  }

  push(amount, timestamp, correlationId) {
    try {
      if (this.processed.has(correlationId)) {
        return false; // Já processado
      }

      this.processed.add(correlationId);
      this.totalRequests++;
      this.totalAmount += (amount / 100); // amount vem em cents
      
      // Armazena para filtros de data (opcional)
      this.payments.push({
        correlationId,
        amount: amount / 100,
        timestamp
      });

      return true;
    } catch (error) {
      return false;
    }
  }

  remove(correlationId) {
    try {
      if (this.processed.has(correlationId)) {
        this.processed.delete(correlationId);
        this.totalRequests = Math.max(0, this.totalRequests - 1);
        
        // Remove dos payments também
        const index = this.payments.findIndex(p => p.correlationId === correlationId);
        if (index !== -1) {
          this.totalAmount -= this.payments[index].amount;
          this.payments.splice(index, 1);
        }
        
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  getSummary(fromTimestamp = null, toTimestamp = null) {
    try {
      if (!fromTimestamp && !toTimestamp) {
        // Consulta ultra-rápida sem filtros
        return {
          totalRequests: this.totalRequests,
          totalAmount: Math.round(this.totalAmount * 100) / 100
        };
      }

      // Com filtros de data
      let filteredRequests = 0;
      let filteredAmount = 0;

      for (const payment of this.payments) {
        if (fromTimestamp && payment.timestamp < fromTimestamp) continue;
        if (toTimestamp && payment.timestamp > toTimestamp) continue;
        
        filteredRequests++;
        filteredAmount += payment.amount;
      }

      return {
        totalRequests: filteredRequests,
        totalAmount: Math.round(filteredAmount * 100) / 100
      };
    } catch (error) {
      return { totalRequests: 0, totalAmount: 0 };
    }
  }
}

const memoryState = {
  default: new MemoryPaymentStorage('default'),
  fallback: new MemoryPaymentStorage('fallback')
};

module.exports = { memoryState, MemoryPaymentStorage };