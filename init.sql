CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    correlation_id UUID UNIQUE NOT NULL,
    amount INTEGER NOT NULL,
    requested_at TIMESTAMP NOT NULL,
    payment_processor VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_requested_at ON payments(requested_at);
CREATE INDEX IF NOT EXISTS idx_payments_processor ON payments(payment_processor);
CREATE INDEX IF NOT EXISTS idx_processor_requested_at ON payments(payment_processor, requested_at);
