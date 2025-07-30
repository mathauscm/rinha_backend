const { Worker } = require('worker_threads');
const path = require('path');
const { floatToCents } = require('../shared');

class Queue {
  constructor(state, options = {}) {
    this.state = state;
    this.queue = [];
    this.head = 0;
    this.tail = 0;
    this.workersFns = [];
    this.workersIdle = [];
    this.processing = new Set(); // Controle de processamento
    
    const workerCount = options.workers || 3;
    const workerPath = path.resolve(__dirname, '../workers/payment.js');
    
    // Criar workers
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerPath);
      this.workersIdle.push(i);
      this.workersFns.push((message) => worker.postMessage(message));
      
      worker.on('message', (message) => this.onWorkerMessage(i, message));
    }
  }

  enqueue(message) {
    // Evita duplicatas na fila
    if (this.processing.has(message.correlationId)) {
      return;
    }
    
    this.queue[this.tail++] = message;
    
    if (this.hasWorkersIdle()) {
      this.startWorker();
    }
  }

  dequeue() {
    if (this.isEmpty()) {
      return undefined;
    }
    
    const message = this.queue[this.head];
    delete this.queue[this.head];
    this.head++;
    
    return message;
  }

  isEmpty() {
    return this.head >= this.tail;
  }

  hasWorkersIdle() {
    return this.workersIdle.length > 0;
  }

  startWorker() {
    const message = this.dequeue();
    if (!message) {
      return;
    }
    
    const workerIndex = this.workersIdle.pop();
    if (workerIndex === undefined) {
      this.queue[--this.head] = message;
      return;
    }
    
    // Marca como sendo processado
    this.processing.add(message.correlationId);
    this.workersFns[workerIndex](message);
  }

  async onWorkerMessage(workerIndex, message) {
    const { state, payload } = message;
    
    switch (state) {
      case 'fulfilled':
        await this.setResultState(payload);
        // Remove do processamento após sucesso
        this.processing.delete(payload.correlationId);
        break;
      case 'rejected':
        // Remove do processamento para permitir retry
        this.processing.delete(payload.correlationId);
        // Requeue apenas se não está sendo processado
        if (!this.processing.has(payload.correlationId)) {
          this.queue[this.tail++] = payload;
        }
        break;
    }
    
    this.workersIdle.push(workerIndex);
    
    if (!this.isEmpty() && this.hasWorkersIdle()) {
      this.startWorker();
    }
  }

  async setResultState(message) {
    const amount = floatToCents(message.amount);
    const timestamp = new Date(message.requestedAt).getTime();
    
    switch (message.paymentProcessor) {
      case 'default':
        await this.state.default.push(amount, timestamp, message.correlationId);
        break;
      case 'fallback':
        await this.state.fallback.push(amount, timestamp, message.correlationId);
        break;
    }
  }
}

module.exports = { Queue };