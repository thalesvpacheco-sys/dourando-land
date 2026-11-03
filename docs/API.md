# API — Dourado Land Intelligence

Base: `/api`. JSON em UTF-8. Autenticação: `Authorization: Bearer <JWT HS256 da identidade WingsBr>` com as claims `sub`, `org`, `role`, `name`, `email` e, para perfis privilegiados, `amr: ["mfa"]`.

Erros: `{ "error": "mensagem", "details": ... }`. Respostas: 400 (validação), 401 (sem token/token inválido/MFA), 403 (perfil sem permissão), 404 (inexistente **ou fora do seu escopo**, para não revelar a existência — proteção contra IDOR), 409 (conflito de versão ou transição inválida), 413 (arquivo grande).

Bloqueio otimista: `PATCH /opportunities/:id` e `PATCH /negotiations/:id` exigem `version` e respondem `409` com `details.current_version` se outra pessoa salvou antes.

## Público (sem login; login opcional amplia a vitrine)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/public/opportunities` | Vitrine com filtros: `q, uf, city, region, type, status, area_min, area_max (m²), price_min, price_max, ppm2_min, ppm2_max, modality (csv), viability (csv), approval (estágio mínimo), infra (agua,energia,esgoto), featured, bbox (lng,lat,lng,lat), sort (recent, area_desc, area_asc), page, per`. Filtros de valor só consideram áreas com valor divulgado. |
| GET | `/public/map` | Mesmos filtros; GeoJSON de pontos públicos (ofuscados conforme precisão), com polígono apenas para áreas de localização exata. |
| GET | `/public/meta` | UFs, cidades e totais da vitrine. |
| GET | `/public/opportunities/:slug` | Página da área. Aceita slug antigo (resolve pelo código) e devolve `canonical_slug`. Inclui `similar`. |
| POST | `/public/opportunities/:slug/interest` | Registra interesse: `{ kind: 'whatsapp'\|'form', name?, email?, phone?, company?, message?, consent?, channel?, attribution? }`. Dados pessoais exigem `consent: true`. Responde `{ token, whatsapp_url, message, routed_to, crm }`. |
| POST | `/public/contact` | Formulários institucionais (proprietário, parceiro, construtora, contato) → CRM. |
| GET | `/public/documents/:id/url` | Link temporário para documento classificado como público. |
| GET | `/public/opportunities/:slug/book.pdf` | Book em PDF (Chromium via Playwright no servidor; 501 se indisponível). |
| POST | `/public/ai/search` | Interpreta busca em linguagem natural → filtros. |
| GET | `/files/:token` | Download por URL assinada (10 min). |
| GET | `/media/...` | Imagens WebP públicas. |

## Áreas (`/opportunities`)

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/` | opportunity.read | Tabela operacional, filtros `q, status, publication, uf, broker, stale` |
| GET | `/export.csv` | opportunity.export | Exportação (auditada) |
| POST | `/` | opportunity.create | `{ internal_name, type, uf, city }` → gera código `DOU-UF-0001` |
| GET | `/:id` | opportunity.read (escopo) | Visão interna filtrada pelo perfil + `checklist` de publicação |
| PATCH | `/:id` | opportunity.update | Rascunho automático: `{ version, draft_step?, fields?, terms?, publication?, technical? }` |
| GET | `/:id/history` | opportunity.update | Auditoria da área |
| POST | `/:id/geometry/import` | opportunity.update | Arquivo KML/KMZ/GeoJSON/SHP(.zip) → GeoJSON (pré-visualização) |
| PUT | `/:id/geometry` | exact_location.update | `{ geojson, source }` → nova versão; área/perímetro geodésicos no PostGIS |
| POST/DELETE | `/:id/owners[/:ownerId]` | owner_data | Proprietários (CPF/CNPJ criptografado) |
| POST | `/:id/media` | opportunity.update | Imagens (convertidas para WebP, sem EXIF) |
| PATCH/DELETE | `/:id/media/:mediaId` | opportunity.update | Legenda, capa, ordem |
| POST | `/:id/documents` | document.create | multipart `file, category, title, confidentiality, valid_until, group_id?` (com `group_id` = nova versão) |
| PATCH | `/:id/documents/:docId` | document.update | Reclassificar, renomear, validade |
| GET | `/:id/documents/:groupId/versions` | document.read | Versões |
| POST | `/:id/assignments` | routing.update | Atribui intermediador (encerra o anterior, guarda histórico) |
| GET | `/:id/assignments/history` | opportunity.read | Histórico de atribuições |
| POST | `/:id/submit-review` | publication.create | Envia para aprovação (exige checklist completo) |
| POST | `/:id/review` | publication.approve | `{ decision: approve\|reject, notes }` |
| POST | `/:id/unpublish` | publication.approve | Retira do portal |
| POST/DELETE | `/:id/favorite` | login | Favoritos |
| GET | `/documents/:docId/url` | document.read | URL temporária (auditada) |

## Interesses e WhatsApp

| Método | Rota | Descrição |
|---|---|---|
| GET | `/interests` | Lista no escopo (`status`, `overdue=1`) |
| GET | `/interests/:id` | Detalhe + linha do tempo + mensagens recebidas |
| POST | `/interests/:id/first-response` | Marca primeiro atendimento (SLA) |
| POST | `/interests/:id/reassign` | `{ broker_id\|null, reason }` |
| POST | `/interests/:id/discard` | `{ reason }` |
| POST | `/interests/:id/convert` | Cria negociação a partir de interesse anônimo identificado na conversa |
| GET | `/interests/inbound/unlinked` | Mensagens sem token (vínculo manual) |
| POST | `/interests/inbound/:id/link` | `{ interest_id }` |
| GET | `/webhooks/whatsapp` | Verificação (`hub.challenge`) |
| POST | `/webhooks/whatsapp` | Cloud API; exige `X-Hub-Signature-256`; idempotente por `message.id` |

## Negociações, propostas e comissões

| Método | Rota | Descrição |
|---|---|---|
| GET/POST | `/negotiations` | Lista (`stage, status, opportunity_id`) / cria |
| GET/PATCH | `/negotiations/:id` | Detalhe completo / etapa, status, motivo de perda, próxima atividade |
| POST | `/negotiations/:id/participants` | Adiciona intermediador |
| POST | `/negotiations/:id/activities` | Nota, ligação, reunião, visita, WhatsApp, e-mail, tarefa (com `due_at`) |
| POST | `/negotiations/activities/:aid/done` | Conclui atividade |
| POST | `/negotiations/:id/proposals` | Proposta v1 |
| POST | `/proposals/:pid/versions` | Nova versão (`side: comprador\|vendedor`) |
| POST | `/proposals/:pid/internal-review` | Envia para análise interna |
| POST | `/proposals/:pid/approval` | `{ decision, comment }` (aprovação interna da versão atual) |
| POST | `/proposals/:pid/status` | `accepted` (exige aprovação interna), `rejected`, `expired` |
| POST | `/negotiations/:id/commissions` | Comissão **prevista** (intermediador com CRECI validado) |
| POST | `/proposals/commissions/:cid/transition` | `contratada` (contrato vinculado) → `exigivel` (etapa Contrato/Conclusão + evento) → `paga` (data); `cancelada` (justificativa) |

## Compradores e matching

`GET/POST/PATCH /partners`, `GET/POST/PATCH/DELETE /profiles`, `GET /matches?opportunity_id|profile_id`, `POST /matches/recompute`, `PATCH /matches/:id { status }`.

## Captação (`/prospects`) e dados territoriais (`/territory`)

| Método e rota | Permissão | Descrição |
|---|---|---|
| `GET /prospects?status=&stage=` | prospect.read | Funil com pré-qualificação (`score`) e `demand_count` |
| `POST /prospects` | prospect.create | Cria a partir do mapa (`territory`, `registry`, `geojson`) ou manualmente; intermediador gera indicação |
| `GET /prospects/:id` | prospect.read | Detalhe, demanda de compradores, itens da nota, histórico, links Earth/ONR |
| `PATCH /prospects/:id` | prospect.update | Autosave com `version` (409 em conflito); mudança de etapa gera atividade |
| `POST /prospects/:id/geometry/import` · `PUT /prospects/:id/geometry` | prospect.update | Perímetro por KML/KMZ/GeoJSON/SHP ou desenho |
| `POST /prospects/:id/activities` · `POST /prospects/:id/discard` | prospect.update | Histórico e descarte com motivo |
| `GET /prospects/:id/overlap` · `GET /opportunities/:id/overlap` | territory.read | Interseção com SIGEF e CAR (m², % da área, % do imóvel) |
| `GET /prospects/:id/kml` · `GET /opportunities/:id/kml` | prospect.read · exact_location.read | KML para importar no Google Earth |
| `POST /prospects/:id/convert` | prospect.approve + opportunity.create | Cria a área (status captação); 400 com `missing` se incompleta |
| `GET /territory/layers` | territory.read | Fontes, modo (demo/live) e situação |
| `GET /territory/features?layer=sigef\|car&bbox=&uf=` | territory.read | GeoJSON do recorte (`too_large` se o recorte for grande demais) |
| `GET /territory/lookup?lat=&lng=&uf=` | territory.read | Parcelas no ponto, consulta registral, links ONR/Earth/SIGEF/CAR e itens já cadastrados no ponto |

`POST /public/contact` com `kind: "proprietario"` também abre uma prospecção (origem `site_proprietario`, base legal consentimento).

## Painel e governança

`GET /dashboard?days=90`, `GET /admin/me`, `GET /admin/users`, `GET/PATCH /admin/brokers[/:id]`, `GET/POST/PATCH/DELETE /admin/routing-rules[/:id]`, `PUT /admin/central-whatsapp`, `GET /admin/audit`, `GET /admin/integrations/status`, `POST /privacy/erase { email?, phone?, reason }`.

## IA assistiva (sempre rotulada como sugestão; origem registrada em `ai_suggestions`)

`POST /ai/opportunities/:id/description`, `GET /ai/opportunities/:id/gaps`, `POST /ai/opportunities/:id/whatsapp-message`, `POST /ai/negotiations/:id/summary`, `POST /ai/search`, `POST /ai/suggestions/:id/accept|reject`.

## Eventos enviados ao WingsBr CRM (outbox)

`POST {WINGSBR_CRM_URL}/events` com corpo `{ kind, payload, source: "dourado-land" }`, cabeçalhos `Idempotency-Key` e `X-WingsBr-Signature: sha256=<HMAC do corpo>`.

| kind | Quando | Campos principais |
|---|---|---|
| `contact.upsert` | Interesse identificado, conversão, formulário institucional | name, email, phone, company, tags, legal_basis, interest_id |
| `lead.create` | Interesse identificado | opportunity_code, channel, attribution (UTMs/IDs de clique), intent_token, broker |
| `deal.upsert` | Criação e mudança de etapa/status da negociação | negotiation_id, crm_deal_id, stage, status |
| `activity.log` | Atividade registrada | activity_id, crm_deal_id, crm_contact_id, type, subject |

Resposta esperada (opcional): `{ contact_id }`, `{ lead_id }`, `{ deal_id }`, `{ activity_id }` — os IDs são gravados no módulo.
