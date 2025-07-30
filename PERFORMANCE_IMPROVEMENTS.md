# Rinha Backend - Performance & Consistency Improvements

## Key Changes Made

### 1. Fixed Consistency Issues (0 inconsistencies target)
- **Removed async processing**: Changed from `setImmediate()` async processing to synchronous processing
- **Eliminated race conditions**: Payments are now processed synchronously before HTTP response
- **Atomic operations**: All Redis operations use Lua scripts for atomicity
- **Proper fallback handling**: Both default and fallback processors are properly recorded

### 2. Performance Optimizations
- **Faster timeouts**: Reduced payment processor timeouts from 1s to 500ms
- **Redis optimization**: Faster connection/command timeouts (1s → 500ms)
- **Nginx improvements**: 
  - Changed to `least_conn` load balancing
  - Reduced proxy timeouts (1s → 100ms)
  - Increased keepalive connections and requests
- **Undici HTTP pool optimization**:
  - Increased connections (20 → 50)
  - Added pipelining (1 → 10)
  - Optimized timeouts

### 3. Load Balancer Options
- **Nginx** (current): Optimized configuration
- **HAProxy** (alternative): Created `docker-compose-haproxy.yml` with HAProxy config

### 4. Resource Allocation Fixed
- **Redis**: Added proper CPU (0.05) and memory (80MB) limits
- **All services**: Optimized resource distribution within 1.5 CPU / 350MB limits

## How to Test

### With Nginx (current):
```bash
# Start payment processors
cd payment-processor
docker-compose up -d

# Start your backend
cd ..
docker-compose up --build
```

### With HAProxy (alternative):
```bash
# Start payment processors  
cd payment-processor
docker-compose up -d

# Start backend with HAProxy
cd ..
docker-compose -f docker-compose-haproxy.yml up --build
```

### Run the test:
```bash
cd rinha-test
k6 run rinha.js
```

## Expected Results
- **Inconsistencies**: 0 (was 217)
- **p99 latency**: <10ms (target for performance bonus)
- **Success rate**: >99%
- **Performance bonus**: Up to 20% if p99 < 1ms

## Architecture Changes
1. **Synchronous processing**: Ensures payment is recorded before HTTP response
2. **Proper error handling**: Only successful payments are recorded
3. **Atomic Redis operations**: Prevents race conditions
4. **Optimized connection pooling**: Better throughput and lower latency