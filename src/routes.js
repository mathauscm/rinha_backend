const { processPayment, getPaymentsSummary } = require('./paymentProcessorClient');

const payments = []; // Em memória (substituir por Redis / DB no futuro)

async function handleRequest(req, res) {
  if (req.url.startsWith('/payments') && req.method === 'POST') {
    await handlePostPayments(req, res);
  } else if (req.url.startsWith('/payments-summary') && req.method === 'GET') {
    await handleGetPaymentsSummary(req, res);
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

async function handlePostPayments(req, res) {
  const body = await getRequestBody(req);
  if (!body || !body.correlationId || typeof body.amount !== 'number') {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'correlationId (string UUID) and amount (number) required' }));
    return;
  }

  // Process payment logic, call payment processors with fallback
  try {
    await processPayment(body.correlationId, body.amount);
    // Save summary (simplified)
    payments.push(body);
    res.statusCode = 200;
    res.end(JSON.stringify({ message: 'Payment processed' }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Failed to process payment' }));
  }
}

async function handleGetPaymentsSummary(req, res) {
  // Simplified: summarize payments in memory
  const summary = payments.reduce(
    (acc, p) => {
      acc.totalRequests++;
      acc.totalAmount += p.amount;
      return acc;
    },
    { totalRequests: 0, totalAmount: 0 }
  );

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    default: summary,
    fallback: { totalRequests: 0, totalAmount: 0 }
  }));
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { // ~1MB limit
        req.connection.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

module.exports = { handleRequest };
