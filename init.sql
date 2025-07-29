
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    correlation_id UUID UNIQUE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    requested_at TIMESTAMP NOT NULL,
    payment_processor VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_payments_requested_at ON payments(requested_at);
CREATE INDEX IF NOT EXISTS idx_payments_processor ON payments(payment_processor);
CREATE INDEX IF NOT EXISTS idx_payments_correlation_id ON payments(correlation_id);