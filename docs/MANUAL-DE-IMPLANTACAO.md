# Manual de implantação

## Requisitos

- Node.js 20.12+ (testado em 22 e 24)
- PostgreSQL 14+ com **PostGIS 3** (testado em PostgreSQL 16 + PostGIS 3.4)
- Para PDF no servidor (opcional): Chromium via `npx playwright install chromium`
- Produção: proxy HTTPS (Caddy/Nginx), storage S3 compatível, Redis (quando houver mais de uma instância)

## Ambiente local

```bash
# 1. banco
createdb dourado
psql dourado -c "CREATE EXTENSION postgis"

# 2. dependências (monorepo com workspaces: shared, server, web)
npm install

# 3. configuração
cp server/.env.example server/.env    # ajuste DATABASE_URL; a API lê este arquivo ao iniciar
cp web/.env.example web/.env

# 4. esquema e dados fictícios
npm run migrate
npm run seed        # recria o banco com 12 áreas, usuários e negociações fictícios

# 5. execução
npm run dev -w server   # API em http://localhost:4200 (worker embutido)
npm run dev -w web      # portal e painel em http://localhost:5174
```

Login de desenvolvimento: `http://localhost:5174/painel/entrar` lista os usuários fictícios quando a API roda com `ENABLE_DEV_LOGIN=true` (já vem no `server/.env.example`). Com `NODE_ENV=production`, o seletor não existe.

## Testes

```bash
createdb dourado_test && psql dourado_test -c "CREATE EXTENSION postgis"
npm test                                   # 27 testes de API (critérios de aceite, permissões, webhook, geo, comissões)
npm run seed && node e2e/fluxo-principal.mjs   # e2e no navegador (precisa da API e do web rodando; usa Playwright)
```

O e2e aprova a área DOU-GO-0007; rode `npm run seed` antes de repeti-lo.

## Variáveis de ambiente (server)

| Variável | Obrigatória em produção | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Postgres com PostGIS |
| `AUTH_JWT_SECRET` | sim | Assina as sessões (`WINGSBR_JWT_SECRET` também é aceito) |
| `REQUIRE_MFA` | — | Padrão em produção: `true`. Exige duas etapas de superadmin, admin e captação |
| `SESSION_HOURS` / `COOKIE_SECURE` | — | Duração da sessão (padrão 12 h) e cookie só por HTTPS (padrão `true` em produção) |
| `SMTP_URL` / `MAIL_FROM` | — | Envio de convite e redefinição; sem isso, o admin copia o link |
| `WEB_DIST_DIR` / `CSP_EXTRA_HOSTS` | — | Serve o front pela API; libera hosts de mapa na política de segurança |
| `DATA_KEY` | sim | 32 bytes em hex (`openssl rand -hex 32`). Cifra CPF/CNPJ e assina URLs. **Não troque sem migrar os dados.** |
| `WINGSBR_CRM_URL` / `WINGSBR_CRM_SECRET` | sim, para sair do modo simulado | Endpoint de eventos do CRM/Leads Hub e segredo HMAC |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` | sim, para o webhook | Configuração do app na Meta |
| `PUBLIC_WEB_URL` | sim | Origem do portal (CORS e geração do PDF) |
| `STORAGE_DIR` | — | Diretório local (até o driver S3 ser implementado) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — | Ativa redação assistida por IA; sem chave, usa heurísticas |
| `EMBEDDED_WORKER` | — | `false` para rodar o worker como processo separado (`npm run worker -w server`) |

| `TERRITORY_MODE` | — | `demo` (parcelas fictícias) ou `live` (bases carregadas ou WFS). Padrão: `demo` fora de produção |
| `TERRITORY_SIGEF_WFS_URL` / `TERRITORY_SIGEF_LAYER` | para camadas reais | Serviço WFS do acervo fundiário (INCRA) e nome da camada; aceita `{uf}` / `{uf_lower}` |
| `TERRITORY_CAR_WFS_URL` / `TERRITORY_CAR_LAYER` | para camadas reais | Serviço WFS do SICAR (ex.: GeoServer do CAR) e camada por UF |
| `ONR_PROVIDER_URL` / `ONR_PROVIDER_TOKEN` | — | Provedor contratado para consulta registral (o ONR não tem API pública) |

Confirme os nomes de camada com o `GetCapabilities` de cada serviço antes de ligar o modo `live`.

Web: `VITE_GOOGLE_MAPS_API_KEY` habilita a vista 3D (Google 3D Maps, cobrada pela Google; restrinja a chave ao domínio do portal). `VITE_MAP_STYLE_URL` (estilo MapLibre de provedor licenciado, ex.: MapTiler/Stadia) e `VITE_SATELLITE_TILES` (template XYZ licenciado). Sem eles, o mapa usa a base própria (contornos de UF).

## Produção

1. `npm run build -w web` → servir `web/dist` como site estático com *fallback* para `index.html` (SPA).
2. API: `NODE_ENV=production npm start -w server` atrás de proxy HTTPS. Encaminhe `/api`, `/media` e `/webhooks` para a API.
3. Worker separado: `EMBEDDED_WORKER=false` na API e `npm run worker -w server` em outro processo.
4. Migrations: `npm run migrate` no deploy (a API também aplica as pendentes ao iniciar).
5. Webhook WhatsApp: no app da Meta, URL `https://<api>/webhooks/whatsapp`, token de verificação = `WHATSAPP_VERIFY_TOKEN`, assinar o campo `messages`.
6. Backups: `pg_dump` diário + retenção de 30 dias; teste de restauração mensal num banco temporário (`pg_restore` + `npm test` apontando `TEST_DATABASE_URL`). Faça backup também do storage de documentos.
7. Ambientes separados (dev, homologação, produção), cada um com seu banco, `DATA_KEY` e segredos.

## Integração com a WingsBr (o que a equipe da plataforma precisa expor)

- Emissão de JWT com `sub, org, role, name, email, amr` — o módulo provisiona o usuário no primeiro acesso.
- Endpoint `POST /events` no CRM/Leads Hub que aceite `contact.upsert`, `lead.create`, `deal.upsert` e `activity.log` com idempotência por `Idempotency-Key` (detalhes em `docs/API.md`).
- Quando o repositório da WingsBr estiver acessível: substituir o adaptador HTTP genérico pelos clientes/SDKs internos e reaproveitar a tela de contatos do CRM no lugar do espelho embutido.
