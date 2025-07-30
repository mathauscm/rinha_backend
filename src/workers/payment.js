const { parentPort } = require('worker_threads');
const { Pool } = require('undici');

// HTTP pools para os Payment Processors
const defaultPool = new Pool('http://payment-processor-default:8080', {
  connections: 5,
  pipelining: 1,
  keepAliveTimeout: 30000
});

const fallbackPool = new Pool('http://payment-processor-fallback:8080', {
  connections: 5,
  pipelining: 1,
  keepAliveTimeout: 30000
});

let reqCount = 0;

parentPort.on('message', (payload) => {
  processPayment(payload)
    .then((result) => {
      if (!result) {
        parentPort.postMessage({
          payload,
          state: 'rejected'
        });
        return;
      }
      
      parentPort.postMessage({
        payload: result,
        state: 'fulfilled'
      });
    })
    .catch(() => {
      parentPort.postMessage({
        payload,
        state: 'rejected'
      });
    });
});

function createPaymentData(jobData) {
  return {
    amount: jobData.amount,
    requestedAt: new Date().toISOString(),
    correlationId: jobData.correlationId
  };
}

async function processWithDefault(data) {
  const paymentData = createPaymentData(data);
  
  try {
    const response = await defaultPool.request({
      path: '/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentData)
    });
    
    if (response.statusCode !== 200) {
      reqCount++;
      throw new Error('Default processor failed');
    }
    
    return {
      ...paymentData,
      paymentProcessor: 'default'
    };
  } catch (error) {
    reqCount++;
    throw error;
  }
}

async function processWithFallback(data) {
  const paymentData = createPaymentData(data);
  
  try {
    const response = await fallbackPool.request({
      path: '/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentData)
    });
    
    if (response.statusCode !== 200) {
      throw new Error('Fallback processor failed');
    }
    
    return {
      ...paymentData,
      paymentProcessor: 'fallback'
    };
  } catch (error) {
    throw error;
  }
}

async function processPayment(data) {
  try {
    return await processWithDefault(data);
  } catch {
    // Use fallback a cada 10 falhas do default
    if (reqCount % 10 === 0) {
      try {
        return await processWithFallback(data);
      } catch {
        return null;
      }
    }
    return null;
  }
}