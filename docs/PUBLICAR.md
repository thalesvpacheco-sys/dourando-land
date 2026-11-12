# Publicar a versão de produção

A versão atual em `areas.douradoimob.com.br` é a **demonstração**: o "servidor" roda no navegador, com dados fictícios. A versão de produção precisa de um servidor com Node e PostgreSQL/PostGIS. A hospedagem LiteSpeed atual serve só arquivos estáticos e não atende.

**Antes de apontar o domínio:** não publique `web/dist` sozinho na hospedagem atual. Sem a API, o painel não funciona.

## 1. Servidor

Um VPS com Ubuntu, pelo menos 2 vCPU, 8 GB de RAM e 100 GB de disco, com Docker instalado. Prefira datacenter no Brasil.

## 2. Configurar

```bash
git clone <repositório> dourado && cd dourado    # ou envie e descompacte o pacote
cp .env.producao.exemplo .env
# preencha DOMINIO, DB_PASSWORD, AUTH_JWT_SECRET e DATA_KEY (openssl rand -hex 32)
```

## 3. Subir

Aponte o DNS do domínio (registro A) para o IP do servidor e rode:

```bash
docker compose up -d --build
docker compose logs -f app     # aguarde a mensagem "API em..."
curl https://SEU-DOMINIO/health
```

O HTTPS é automático (Caddy). As migrações rodam ao iniciar.

## 4. Primeiro administrador

```bash
docker compose exec app npm run bootstrap -- --email voce@empresa.com --name "Seu Nome"
```

Abra o link impresso (uso único) e defina a senha. Depois, convide a equipe em **Usuários**. A verificação em duas etapas está desligada; para exigi-la de administradores, coloque `REQUIRE_MFA=true` no `.env` e rode `docker compose up -d`. Nesse caso, tenha pelo menos dois administradores: quem perde o celular depende do outro para zerar as duas etapas.

Pelo terminal, um administrador pode gerar novo link rodando o mesmo comando (sem zerar as duas etapas).

## 5. Importar as áreas

Copie a pasta inteira para o servidor (1,7 GB), em `carga/grandes-negocios`:

```bash
rsync -av --exclude '*.mp4' "/caminho/GRANDES NEGÓCIOS /" usuario@servidor:dourado/carga/grandes-negocios/

# prévia: não grava nada
docker compose exec app npm run import:inventory -- --dir /carga/grandes-negocios --org dourado --out /tmp/previa.json
# aplicar (pode repetir: não duplica e preserva o que a equipe editou)
docker compose exec app npm run import:inventory -- --dir /carga/grandes-negocios --org dourado --user voce@empresa.com --apply --out /tmp/aplicacao.json
```

Resultado esperado: 85 áreas no banco (rascunho, vitrine privada) e 43 prospecções no funil. **Nada é publicado.** O portal continua vazio até um administrador aprovar cada área.

Se os nomes de arquivos mudarem no Drive, a contagem pode variar: confira o relatório.

## 6. Carregar as bases territoriais

**Atalho (recomendado):** `UFS="GO DF" sh scripts/atualizar-bases.sh` na pasta do projeto no servidor. Baixa dos serviços oficiais que estão no ar e carrega tudo:

| Camada | Fonte usada pelo script |
|---|---|
| SIGEF | INCRA, cópia publicada pelo IBAMA (`pamgia.ibama.gov.br`), com imóveis aprovados até **abr/2022**. Quando o download oficial do INCRA voltar, o script troca pela base oficial atualizada. |
| Assentamentos | INCRA, cópia publicada pelo IBAMA |
| Embargos | IBAMA e ICMBio (sem nome nem CPF/CNPJ do autuado) |
| Unidades de conservação | ICMBio (federais) e SFB (estaduais) |
| Terras indígenas | FUNAI |
| CAR (imóveis) | Consulta ao vivo no WFS do SICAR (`TERRITORY_CAR_WFS_URL` / `TERRITORY_CAR_LAYER` no `.env`), sem carga |

Desde 01/11/2026 `certificacao.incra.gov.br` e `acervofundiario.incra.gov.br` não resolvem no DNS (falha do INCRA). Enquanto isso, SNCI e quilombolas ficam pendentes. Os temas do CAR (APP, reserva legal etc.) exigem download manual no SICAR, que pede captcha.

Carga manual, arquivo por arquivo:

Sem esta etapa, o mapa de prospecção fica sem parcelas e os painéis informam "ainda não carregada". Baixe os arquivos nos sites oficiais e copie para `carga/`:

```bash
docker compose exec app npm run territory:import -- --layer sigef --uf GO --file /carga/sigef_GO.zip
```

| `--layer` | Conteúdo | Onde baixar |
|---|---|---|
| `sigef` / `snci` | Imóveis certificados | [INCRA, Acervo Fundiário](https://acervofundiario.incra.gov.br/acervo/acv.php) |
| `assentamento` / `quilombola` | Assentamentos e quilombolas | Mesmo site do INCRA |
| `car` | Imóveis do CAR (`AREA_IMOVEL`) | [SICAR, por estado](https://consultapublica.car.gov.br/publico/estados/downloads) |
| `car_app`, `car_rl`, `car_hidro`, `car_uso_restrito`, `car_vegetacao`, `car_consolidada` | Temas do CAR | Mesmo site do SICAR |
| `terra_indigena` | Terras indígenas | [FUNAI](https://www.gov.br/funai/pt-br/atuacao/terras-indigenas/geoprocessamento-e-mapas) |
| `uc` | Unidades de conservação | [MMA](https://www.gov.br/mma/pt-br/assuntos/biodiversidade-e-biomas/areas-protegidas) |
| `embargo` | Áreas embargadas | [IBAMA](https://www.gov.br/ibama/pt-br/assuntos/fiscalizacao-e-protecao-ambiental/fiscalizacao/areas-embargadas) |
| `desmatamento` | Alertas | [MapBiomas Alerta](https://alerta.mapbiomas.org/) |

- Em 05/11/2026, o endereço direto de exportação do INCRA (`certificacao.incra.gov.br`) não abriu em nosso teste. Se continuar assim, entre pelo Acervo Fundiário.
- O arquivo pode ser `.zip` ou `.shp`, em coordenadas geográficas (SIRGAS 2000 ou WGS 84). Acentos errados? Acrescente `--encoding latin1`.
- A carga substitui aquela camada/UF numa única transação: se falhar, a base anterior continua valendo.
- O site do SICAR pede captcha: baixe manualmente. Não automatize a resolução do captcha.
- **Repita periodicamente.** A plataforma mostra a data de cada carga, mas não atualiza sozinha.
- Comece por UF de maior interesse. Bases do CAR de estados grandes ocupam bastante disco: acompanhe com `df -h`.

## 7. Opcionais

| Recurso | O que fazer |
|---|---|
| Satélite | Contrate um provedor licenciado (ex.: MapTiler) e preencha `VITE_SATELLITE_TILES` (ex.: `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=SUA_CHAVE`), `VITE_SATELLITE_ATTRIBUTION` e `CSP_EXTRA_HOSTS=https://api.maptiler.com`. Restrinja a chave ao domínio e rode `docker compose up -d --build`. |
| E-mail | Preencha `SMTP_URL` (ex.: `smtp://usuario:senha@smtp.exemplo.com:587`). Sem ele, "Esqueci a senha" não envia nada: o administrador gera o link em Usuários. |
| Leitura de matrícula | Preencha `ANTHROPIC_API_KEY`. O PDF é enviado ao provedor de IA: avalie com o jurídico e confirme que o contrato com o provedor atende à LGPD. |
| Consulta registral | Contrate um provedor do Mapa ONR e preencha `ONR_PROVIDER_URL` e `ONR_PROVIDER_TOKEN`. |

## 8. Backup

```bash
# banco, diariamente (cron), com retenção de 30 dias fora do servidor
docker compose exec -T db pg_dump -U dourado -Fc dourado > backup-$(date +%F).dump
# arquivos enviados: volume "storage" (documentos e imagens)
```

Teste a restauração uma vez por mês. Guarde `.env` em cofre de senhas: sem `DATA_KEY`, os CPF/CNPJ cifrados não podem ser lidos.

## 9. Conferência depois de publicar

- [ ] `/painel` sem login leva à tela de entrada
- [ ] `/api/opportunities` sem login responde 401
- [ ] O login não oferece seletor de usuários
- [ ] Com `REQUIRE_MFA=true`, administrador só entra com o segundo fator
- [ ] O portal não mostra nenhuma área antes da aprovação
- [ ] Certificado HTTPS válido e backup restaurado em teste
