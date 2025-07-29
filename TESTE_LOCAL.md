# Guia de Teste Local - Rinha Backend 2025

## Pré-requisitos
- Docker e Docker Compose instalados
- Git (para clonar o repositório dos Payment Processors)

## Passo a Passo para Testar Localmente

### 1. Configurar os Payment Processors

Primeiro, você precisa baixar e executar os Payment Processors que sua aplicação irá se integrar:

```bash
# Clone o repositório dos Payment Processors
git clone https://github.com/zanfranceschi/rinha-de-backend-2025-payment-processor.git
cd rinha-de-backend-2025-payment-processor/payment-processor

# Inicie os Payment Processors (isso criará a rede payment-processor)
docker-compose up -d
```

Os Payment Processors estarão disponíveis em:
- **Payment Processor Default**: http://localhost:8001
- **Payment Processor Fallback**: http://localhost:8002

### 2. Executar sua Aplicação

Volte para o diretório do seu projeto e execute:

```bash
cd /home/mathaus/projects/rinha-backend

# Construa e execute sua aplicação
docker-compose up -d
```

Sua aplicação estará disponível em: http://localhost:9999

### 3. Testar os Endpoints

#### Teste de Health Check dos Payment Processors

```bash
# Payment Processor Default
curl http://localhost:8001/payments/service-health

# Payment Processor Fallback  
curl http://localhost:8002/payments/service-health
```

#### Teste do Endpoint de Pagamentos

```bash
curl -X POST http://localhost:9999/payments \
  -H "Content-Type: application/json" \
  -d '{
    "correlationId": "4a7901b8-7d26-4d9d-aa19-4dc1c7cf60b3",
    "amount": 19.90
  }'
```

#### Teste do Endpoint de Resumo

```bash
curl "http://localhost:9999/payments-summary"
```

Com filtros de data:
```bash
curl "http://localhost:9999/payments-summary?from=2025-01-01T00:00:00.000Z&to=2025-12-31T23:59:59.000Z"
```

### 4. Simular Falhas nos Payment Processors

Para testar como sua aplicação se comporta com falhas, você pode configurar os Payment Processors:

#### Configurar Delay (atraso)
```bash
# Adicionar 2 segundos de delay no Default
curl -X PUT http://localhost:8001/admin/configurations/delay \
  -H "Content-Type: application/json" \
  -H "X-Rinha-Token: 123" \
  -d '{"delay": 2000}'
```

#### Configurar Falha
```bash
# Fazer o Default falhar
curl -X PUT http://localhost:8001/admin/configurations/failure \
  -H "Content-Type: application/json" \
  -H "X-Rinha-Token: 123" \
  -d '{"failure": true}'

# Remover a falha
curl -X PUT http://localhost:8001/admin/configurations/failure \
  -H "Content-Type: application/json" \
  -H "X-Rinha-Token: 123" \
  -d '{"failure": false}'
```

### 5. Verificar Consistência

Compare os dados entre sua aplicação e os Payment Processors:

```bash
# Seu backend
curl "http://localhost:9999/payments-summary"

# Payment Processor Default
curl -H "X-Rinha-Token: 123" "http://localhost:8001/admin/payments-summary"

# Payment Processor Fallback
curl -H "X-Rinha-Token: 123" "http://localhost:8002/admin/payments-summary"
```

### 6. Limpar Dados (Para Desenvolvimento)

Para reiniciar os testes com dados limpos:

```bash
# Limpar Payment Processor Default
curl -X POST http://localhost:8001/admin/purge-payments \
  -H "X-Rinha-Token: 123"

# Limpar Payment Processor Fallback
curl -X POST http://localhost:8002/admin/purge-payments \
  -H "X-Rinha-Token: 123"

# Reiniciar sua aplicação
docker-compose restart
```

### 7. Monitorar Logs

Para acompanhar o funcionamento:

```bash
# Logs da sua aplicação
docker-compose logs -f

# Logs específicos de um serviço
docker-compose logs -f backend1
docker-compose logs -f worker
docker-compose logs -f nginx
```

### 8. Parar os Serviços

```bash
# Parar sua aplicação
docker-compose down

# Parar os Payment Processors
cd ../rinha-de-backend-2025-payment-processor/payment-processor
docker-compose down
```

## Dicas Importantes

1. **Ordem de Inicialização**: Sempre inicie os Payment Processors antes da sua aplicação
2. **Rate Limit**: O endpoint de health check tem limite de 1 chamada a cada 5 segundos
3. **Consistência**: Verifique sempre se os totais batem entre sua aplicação e os processors
4. **Recursos**: Sua aplicação está limitada a 1,5 CPU e 350MB de RAM total
5. **Token Admin**: O token padrão para endpoints administrativos é `123`

## Estrutura de Teste de Carga

Para testes mais intensivos, considere usar ferramentas como:
- Apache Bench (ab)
- wrk
- Artillery
- K6

Exemplo com Apache Bench:
```bash
ab -n 1000 -c 10 -T 'application/json' -p payment.json http://localhost:9999/payments
```

Onde `payment.json` contém:
```json
{
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "amount": 100.00
}
```