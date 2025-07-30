const { startServer } = require('./config/server');
const { PaymentService } = require('./services/PaymentService');
const { sharedState } = require('./state/redisState');

const PORT = process.env.PORT || 9999;

// Criar serviço de pagamento com Redis otimizado
const paymentService = new PaymentService(sharedState);

// Iniciar servidor
startServer(PORT, paymentService, sharedState);

console.log('Rinha Backend started with high-performance processing!');