const uWS = require('uws');
const { encode, decode } = require('@msgpack/msgpack');
const paymentsHandler = require('./api/paymentsHandler-uws');

const PORT = process.env.PORT || 9999;

// V8 otimizações extremas
if (process.env.NODE_ENV === 'production') {
  process.env.UV_THREADPOOL_SIZE = '32';
}

// Cache local para requests duplicados (100ms TTL)
const requestCache = new Map();
const CACHE_TTL = 100;

function cleanupCache() {
  const now = Date.now();
  for (const [key, data] of requestCache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      requestCache.delete(key);
    }
  }
}
setInterval(cleanupCache, 50);

const app = uWS.App({
  compression: uWS.DISABLED,
  maxCompressedSize: 0,
  maxBackpressure: 0,
}).post('/payments', async (res, req) => {
  res.onAborted(() => {
    res.aborted = true;
  });

  let buffer = Buffer.allocUnsafe(0);
  
  res.onData((chunk, isLast) => {
    const chunkBuffer = Buffer.from(chunk);
    buffer = Buffer.concat([buffer, chunkBuffer]);
    
    if (isLast) {
      if (res.aborted) return;
      
      try {
        const body = JSON.parse(buffer.toString());
        const cacheKey = body.correlationId;
        
        // Cache check para evitar processamento duplicado
        const cached = requestCache.get(cacheKey);
        if (cached) {
          res.writeStatus('201').writeHeader('Content-Type', 'application/json');
          res.end('{"message":"Payment queued"}');
          return;
        }
        
        // Processa o pagamento
        paymentsHandler.handlePostPayments(body).then(() => {
          if (res.aborted) return;
          
          // Adiciona ao cache
          requestCache.set(cacheKey, { timestamp: Date.now() });
          
          res.writeStatus('201').writeHeader('Content-Type', 'application/json');
          res.end('{"message":"Payment queued"}');
        }).catch(() => {
          if (res.aborted) return;
          res.writeStatus('500').writeHeader('Content-Type', 'application/json');
          res.end('{"error":"Internal Server Error"}');
        });
        
      } catch (err) {
        if (res.aborted) return;
        res.writeStatus('400').writeHeader('Content-Type', 'application/json');
        res.end('{"error":"Invalid JSON"}');
      }
    }
  });

}).get('/payments-summary', async (res, req) => {
  res.onAborted(() => {
    res.aborted = true;
  });

  try {
    const query = req.getQuery();
    const params = new URLSearchParams(query);
    
    const summary = await paymentsHandler.handleGetPaymentsSummary(params);
    
    if (res.aborted) return;
    
    res.writeStatus('200').writeHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(summary));
  } catch (err) {
    if (res.aborted) return;
    res.writeStatus('500').writeHeader('Content-Type', 'application/json');
    res.end('{"error":"Internal Server Error"}');
  }

}).any('/*', (res, req) => {
  res.writeStatus('404').writeHeader('Content-Type', 'application/json');
  res.end('{"error":"Not Found"}');

}).listen(PORT, (token) => {
  if (token) {
    console.log(`uWS server listening on port ${PORT}`);
  } else {
    console.log(`Failed to listen to port ${PORT}`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down uWS server...');
  uWS.us_listen_socket_close(app);
  process.exit(0);
});