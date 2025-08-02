const { startServer } = require('./config/server');
const { PaymentService } = require('./services/PaymentService');
const { sharedState } = require('./state/redisState');

const PORT = process.env.PORT || 9999;

const paymentService = new PaymentService(sharedState);

// Torna o paymentService globalmente acessível para monitoramento
global.paymentService = paymentService;

startServer(PORT, paymentService, sharedState);
