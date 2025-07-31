const { startServer } = require('./config/server');
const { PaymentService } = require('./services/PaymentService');
const { sharedState } = require('./state/redisState');

const PORT = process.env.PORT || 9999;

// ESTRATÉGIA FINAL: Redis + lógica perfeita
const paymentService = new PaymentService(sharedState);

// Make paymentService globally accessible for monitoring
global.paymentService = paymentService;

startServer(PORT, paymentService, sharedState);

console.log('Rinha Backend started - FINAL STRATEGY for ZERO inconsistencies!');