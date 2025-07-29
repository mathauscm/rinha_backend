# 🚀 Rinha Backend 2025
### 🔥 Otimizações Implementadas

**1. uWS (MicroWebSockets)**
- Substitui HTTP nativo Node.js
- Bindings C++ ultra-rápidos
- Cache local de requests (100ms TTL)

**2. V8 Flags Extremas**
```bash
--max-old-space-size=100
--gc-interval=100
--optimize-for-size
--turbo-fast-api-calls
```

**3. MessagePack + Object Pooling**
- Serialização 40% mais rápida que JSON
- Zero-allocation object reuse
- Buffer pools para requests

**4. Redis Lua Scripts Atômicos**
- Operações Redis em script único
- Elimina round-trips
- 100% atômico

**5. Worker Pool Paralelo**
- 16 workers simultâneos
- Batch processing (20 items)
- Timeouts agressivos (200ms)

**6. Redis Sem Persistência**
- Apenas memória (sem disk I/O)
- IO threads habilitados
- Políticas LRU otimizadas

### 📊 Arquitetura

```
nginx (keepalive 100k) 
  ↓
uWS servers (2x)
  ↓
Redis (Lua scripts)
  ↓  
Worker pool (16x)
  ↓
HTTP pools (undici)
```

### 🏃‍♂️ Como Executar

```bash
npm install
docker-compose up --build
```
