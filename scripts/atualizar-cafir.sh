#!/bin/sh
# Atualiza o CAFIR (NIRF por código INCRA) no servidor. Rodar na pasta do projeto, ex.: /opt/dourado.
#
#   sh scripts/atualizar-cafir.sh              # UFs com base SIGEF carregada
#   UFS="ALL" sh scripts/atualizar-cafir.sh    # Brasil inteiro (~2,6 GB de download)
#
# Baixa a edição mais recente da Receita, carrega numa tabela de passagem e troca o conteúdo numa transação:
# se algo falhar no meio, o CAFIR anterior continua valendo.
set -eu
cd "$(dirname "$0")/.."
log() { echo "[$(date '+%F %T')] $*"; }
psql_db() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -U dourado -d dourado "$@"; }

if [ -z "${UFS:-}" ]; then
  UFS=$(psql_db -At -c "SELECT string_agg(DISTINCT uf, ' ') FROM territory_datasets WHERE layer IN ('sigef','snci')")
fi
[ -n "$UFS" ] || { log "Nenhuma UF com SIGEF carregado; informe UFS=\"GO SP\""; exit 1; }
log "CAFIR: UFs $UFS"

mkdir -p carga/cafir
python3 scripts/baixar-cafir.py --uf $UFS --dest carga/cafir > carga/cafir/cafir.csv

psql_db -q <<'SQL'
DROP TABLE IF EXISTS cafir_carga;
CREATE UNLOGGED TABLE cafir_carga (nirf text, sncr text, area_ha double precision, nome text, situacao text, municipio text, uf text, data_inscricao text, edicao text);
SQL
psql_db -q -c "\copy cafir_carga FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')" < carga/cafir/cafir.csv
psql_db -q <<'SQL'
BEGIN;
DELETE FROM cafir_imoveis;
INSERT INTO cafir_imoveis (nirf, sncr, area_ha, nome, situacao, municipio, uf, data_inscricao, edicao)
  SELECT DISTINCT ON (nirf) nirf, nullif(sncr, ''), area_ha, nome, situacao, municipio, uf, data_inscricao, edicao FROM cafir_carga ORDER BY nirf;
COMMIT;
DROP TABLE cafir_carga;
ANALYZE cafir_imoveis;
SQL
rm -f carga/cafir/cafir.csv
log "NIRF provável (nome, município e área) para quem não tem vínculo pelo código INCRA"
psql_db -q < scripts/cafir-provavel.sql
log "Concluído: $(psql_db -At -c "SELECT count(*) || ' imóveis, ' || count(sncr) || ' com código INCRA, edição ' || max(edicao) FROM cafir_imoveis"); $(psql_db -At -c "SELECT count(*) FROM cafir_provavel") NIRF prováveis"
