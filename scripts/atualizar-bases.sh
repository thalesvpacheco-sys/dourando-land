#!/bin/sh
# Atualiza as bases territoriais no servidor (rodar na pasta do projeto, ex.: /opt/dourado).
#
#   UFS="GO DF" sh scripts/atualizar-bases.sh
#
# 1. Baixa dos serviços oficiais que respondem hoje (IBAMA, FUNAI, ICMBio) e carrega no PostGIS.
# 2. Se o download do INCRA (certificacao.incra.gov.br) estiver no ar, troca a cópia do SIGEF/assentamentos pela base
#    oficial atualizada e carrega SNCI e quilombolas. Fora do ar (como desde nov/2026), mantém a cópia e registra no log.
# Pode rodar quantas vezes quiser: cada carga substitui a camada/UF numa transação; se falhar, a anterior continua valendo.
set -u
cd "$(dirname "$0")/.."
UFS="${UFS:-GO DF}"
CARGA=carga
mkdir -p "$CARGA"
log() { echo "[$(date '+%F %T')] $*"; }
# </dev/null: sem isso o docker consome a entrada do laço que lê a lista de bases
imp() { docker compose exec -T app npx tsx src/integrations/territory-cli.ts "$@" </dev/null 2>&1 | grep -v 'npm notice'; }

log "Bases de serviços oficiais (UFs: $UFS)"
python3 scripts/baixar-bases.py --uf $UFS --dest "$CARGA" || log "Falha no download (as bases já carregadas continuam valendo)"
python3 - "$CARGA/bases.json" <<'EOF' | while IFS='|' read -r layer uf file source; do imp --layer "$layer" --uf "$uf" --file "/carga/$file" --source "$source"; done
import json, sys
for b in json.load(open(sys.argv[1], encoding='utf-8')): print('|'.join([b['layer'], b['uf'], b['file'], b['source']]))
EOF

INCRA=https://certificacao.incra.gov.br/csv_shp/zip
if ! getent hosts certificacao.incra.gov.br >/dev/null; then
  log "INCRA: certificacao.incra.gov.br não resolve no DNS. SIGEF segue com a cópia do IBAMA; SNCI e quilombolas ficam pendentes."
  exit 0
fi
baixa() { curl -sfL -m 1800 -A 'Mozilla/5.0' -o "$CARGA/$2" "$INCRA/$(printf '%s' "$1" | sed 's/ /%20/g')" && unzip -tq "$CARGA/$2" >/dev/null 2>&1; }
for uf in $UFS; do
  # SIGEF: o INCRA separa privados e públicos; o segundo arquivo é somado ao primeiro (--append)
  if baixa "Sigef Privado_$uf.zip" "incra_sigef_priv_$uf.zip"; then
    imp --layer sigef --uf "$uf" --file "/carga/incra_sigef_priv_$uf.zip" --source "INCRA — Acervo Fundiário (SIGEF), oficial" \
      && baixa "Sigef Público_$uf.zip" "incra_sigef_pub_$uf.zip" \
      && imp --layer sigef --uf "$uf" --file "/carga/incra_sigef_pub_$uf.zip" --source "INCRA — Acervo Fundiário (SIGEF), oficial" --append
  elif baixa "Sigef Brasil_$uf.zip" "incra_sigef_$uf.zip"; then
    imp --layer sigef --uf "$uf" --file "/carga/incra_sigef_$uf.zip" --source "INCRA — Acervo Fundiário (SIGEF), oficial"
  else log "INCRA: SIGEF de $uf indisponível"; fi
  baixa "SNCI Brasil_$uf.zip" "incra_snci_$uf.zip" && imp --layer snci --uf "$uf" --file "/carga/incra_snci_$uf.zip" --source "INCRA — Acervo Fundiário (SNCI)" --encoding latin1 || log "INCRA: SNCI de $uf indisponível"
  baixa "Áreas de Quilombolas_$uf.zip" "incra_quilombola_$uf.zip" && imp --layer quilombola --uf "$uf" --file "/carga/incra_quilombola_$uf.zip" --source "INCRA — territórios quilombolas" --encoding latin1 || log "INCRA: quilombolas de $uf indisponível"
done
log "Concluído"
