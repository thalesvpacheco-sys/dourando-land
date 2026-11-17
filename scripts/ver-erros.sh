#!/bin/sh
# Erros recentes da plataforma (API e telas), um por linha, com quem fez.
#   sh scripts/ver-erros.sh          -> última 1 hora
#   sh scripts/ver-erros.sh 24h      -> últimas 24 horas
#   sh scripts/ver-erros.sh 2h tudo  -> inclui também as alterações que deram certo
cd "$(dirname "$0")/.." || exit 1
DESDE="${1:-1h}"
if [ "$2" = "tudo" ]; then FILTRO='"msg":"(request|request_failed|client_error|unhandled_error)"'
else FILTRO='"msg":"(request_failed|client_error|unhandled_error)"'; fi
docker compose logs app --no-log-prefix --since "$DESDE" 2>/dev/null | grep -E "$FILTRO"
