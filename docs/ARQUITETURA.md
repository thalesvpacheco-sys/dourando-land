# Dourado Land Intelligence — Documento de Arquitetura

Versão 0.1 · novembro/2026 · Módulo da plataforma WingsBr operado pela Dourado Real Estate Partners

## 1. Contexto e premissas

O repositório principal da WingsBr não estava acessível durante a construção. Por isso, o módulo segue a mesma stack e as mesmas convenções dos módulos já entregues (E-mail Marketing e WingsBr Pages): Node + TypeScript, Express, Knex, React + Vite, multiempresa por organização e JWT HS256 emitido pelo serviço de identidade da WingsBr.

A diferença é o banco: este módulo **exige PostgreSQL + PostGIS** desde o desenvolvimento, porque as consultas espaciais (área geodésica, interseção por bounding box, localização aproximada) fazem parte das regras de negócio e não podem ser simuladas em SQLite.

Princípios:

1. **Não existe um segundo CRM.** Contatos, leads e atividades pertencem ao WingsBr CRM / Leads Hub. O módulo guarda apenas referências (`crm_contact_id`, `crm_deal_id`) e entrega eventos por um adaptador com fila (outbox). Sem `WINGSBR_CRM_URL`, o adaptador roda em **modo embutido**, explicitamente marcado como simulado.
2. **Cadastro não é publicação.** Uma área só vai ao portal com autorização de divulgação (documento ou base jurídica registrada) e aprovação de um administrador.
3. **Nada inventado.** Todo parâmetro técnico tem fonte, data de consulta, responsável e status de validação. IA e matching só usam dados cadastrados e marcam o que não está verificado.
4. **Clique não é conversa.** O portal registra cliques; conversa iniciada e mensagem recebida só são confirmadas por webhook oficial com identificador verificável.

## 2. Visão de componentes

```
                ┌───────────────────────── WingsBr (serviços compartilhados) ─────────────────────────┐
                │  Identidade (JWT)   CRM / Leads Hub   Projects   Mensageria   Analytics              │
                └─────────▲──────────────────▲─────────────────────────────────────────────────────────┘
                          │ JWT HS256        │ HTTP + HMAC + Idempotency-Key (outbox, 8 tentativas)
┌──────────────┐   ┌──────┴──────────────────┴──────┐   ┌──────────────────────┐
│ web (React)  │──▶│ server (Express, porta 4200)    │──▶│ PostgreSQL + PostGIS │
│ portal +     │   │  /api/public  (sem login)       │   └──────────────────────┘
│ painel       │   │  /api/...     (JWT + RBAC)      │   ┌──────────────────────┐
└──────────────┘   │  /webhooks/whatsapp             │──▶│ Storage (local → S3) │
                   │  worker: outbox CRM, alertas    │   └──────────────────────┘
                   └──────────────┬──────────────────┘
                                  │ Cloud API (webhook assinado X-Hub-Signature-256)
                          WhatsApp Business Platform
```

## 3. Perfis e autorização

A autorização acontece em três camadas: papel (o que pode fazer), organização (de quem é o dado) e oportunidade (a qual área o usuário tem vínculo). As regras estão em `server/src/auth/permissions.ts` e são aplicadas no backend; o banco reforça o isolamento com `org_id` obrigatório em todas as consultas de domínio.

| Perfil | Chave | Áreas | Comercial / comissões | Observações |
|---|---|---|---|---|
| Superadministrador WingsBr | `platform_admin` | sem acesso comercial por padrão | não | organizações, integrações, saúde; MFA obrigatório |
| Administrador Dourado | `dourado_admin` | todas da organização | sim | aprova publicação, distribui leads, exporta; MFA obrigatório |
| Gestor de captação | `capture_manager` | todas da organização | condições sim, comissões não | cadastra, qualifica, valida documentos; MFA obrigatório |
| Intermediador / corretor | `broker` | só as atribuídas | só a própria comissão | CRECI registrado e com situação validada |
| Proprietário / representante | `owner` | só as próprias | não | envia documentos, acompanha status |
| Construtora / investidor | `buyer` | vitrine pública + privada | não | perfis de aquisição, favoritos, propostas próprias |
| Visitante | — | vitrine pública | não | demonstra interesse |

Ações: `read`, `create`, `update`, `export`, `share`, `approve`, `delete`. Exportação é registrada em auditoria.

## 4. Modelo de dados (resumo ER)

Todas as tabelas usam UUID, `created_at`, `updated_at`. Entidades sujeitas a edição concorrente têm `version` (bloqueio otimista).

```
organizations 1─* users ─* broker_assignments *─1 land_opportunities
                  │                                   │
                  └─1 land_brokers                    ├─1 land_geometries (MultiPolygon 4326, versionadas)
                                                      ├─* land_technical_attributes (fonte, data, responsável, validação)
partner_companies 1─* acquisition_profiles            ├─1 land_commercial_terms
        │                  │                          ├─1 publication_permissions
        │                  └─* opportunity_matches ─*─┤
        │                                             ├─* land_owners (dados privados)
        │                                             ├─* land_documents (versão, validade, confidencialidade)
        │                                             ├─* land_media
        │                                             ├─* opportunity_interests ─* interest_events
        └─* negotiations *────────────────────────────┘
               ├─* negotiation_participants
               ├─* proposals ─* proposal_versions, proposal_approvals
               ├─* commissions
               └─* activities
whatsapp_routing_rules · crm_outbox · audit_logs · ai_suggestions · crm_contacts (modo embutido)
```

Classificação de dados (`server/src/domain/serializers.ts`):

| Classe | Exemplos | Quem vê |
|---|---|---|
| Pública | título, cidade/UF, metragem, modalidade, preço se liberado | todos |
| Privada (vitrine logada) | idem, quando `visibility = private` | buyer, broker atribuído, equipe |
| Interna | parâmetros técnicos completos, notas, responsáveis | equipe Dourado e broker atribuído |
| Confidencial | proprietários, geometria exata, documentos confidenciais, comissões | admin; captação (sem comissões) |
| Restrita por negociação | propostas, minutas | participantes da negociação e admin |

## 5. Fluxos principais

**Publicação.** `draft → pending_review → published` (ou `rejected`). O envio para revisão exige: título, cidade/UF, área, tipo, localização, pelo menos uma imagem e autorização de divulgação (documento da categoria `authorization` ou base jurídica descrita). A aprovação é feita por `dourado_admin` e fica auditada.

**Interesse e WhatsApp.**
1. O visitante clica em "Tenho interesse" → `POST /api/public/opportunities/:code/interest`.
2. O servidor gera um token `DL-XXXXXX`, grava canal, UTMs e IDs de clique, e aplica as regras de roteamento (prioridade → intermediador atribuído → fila com rodízio → número central).
3. Se houver dados pessoais, exige consentimento e faz o upsert do contato no CRM (adaptador + outbox).
4. A resposta traz o link `wa.me` com a mensagem contextualizada e o token.
5. O webhook oficial confirma: `conversation_started` (primeira mensagem do número) e `message_received` (mensagem que contém o token). Mensagens sem token ficam em "não vinculadas", para vínculo manual, sem associação automática.

**Negociação.** As etapas da área (Captação → Qualificação → Disponível) ficam no status da oportunidade. Cada negociação percorre: Interesse recebido → Apresentação → Análise de viabilidade → Proposta → Negociação → Due diligence → Contrato → Conclusão. Pode haver várias negociações simultâneas por área.

**Comissão.** O registro nasce como `prevista` e só avança para `contratada → exigível → paga` com evento explícito (contrato vinculado, condição cumprida). Proposta ou cadastro nunca geram comissão devida.

**Matching.** Motor determinístico com pesos explicáveis: localização 25, metragem 20, tipologia/viabilidade 20, orçamento 15, modalidade/permuta 10, estágio de aprovação 10. Restrições técnicas excluem com motivo. Atributos não verificados reduzem a confiança e aparecem na explicação.

## 6. Segurança

- Controle de acesso no backend em toda rota e escopo `org_id` em toda consulta; testes de IDOR e de acesso entre organizações.
- MFA exigido para perfis privilegiados quando `REQUIRE_MFA=true` (claim `amr` contendo `mfa`).
- Documentos servidos só por URL temporária assinada (HMAC, 10 minutos), gerada após checar permissão e registrada em auditoria.
- Uploads: verificação da assinatura do arquivo (magic bytes), lista de tipos permitidos, limite de tamanho, imagens convertidas para WebP (remove metadados/EXIF).
- CPF/CNPJ de proprietários criptografados (AES-256-GCM).
- IP guardado só como hash; limitação de requisições nas rotas públicas e no login.
- Helmet/CSP; webhook do WhatsApp com verificação de assinatura.
- Retenção: interesses sem dados pessoais são anonimizados após 24 meses (job do worker); direito do titular via `DELETE /api/privacy/contacts`.

## 7. Integrações

| Integração | Situação |
|---|---|
| WingsBr Identidade (JWT HS256) | **Implementado** (validação); login de demonstração só em desenvolvimento |
| WingsBr CRM / Leads Hub | **Implementado** o adaptador HTTP com HMAC, idempotência e outbox; **simulado** em modo embutido sem URL configurada |
| WhatsApp Business Platform | **Implementado** link contextual e webhook assinado; **pendente** número/app oficial da Dourado |
| PostGIS | **Implementado** |
| Importação KML/KMZ/GeoJSON/SHP | **Implementado** |
| Mapas (MapLibre) | **Implementado**; o estilo padrão de demonstração deve ser trocado por provedor licenciado (`VITE_MAP_STYLE_URL`) |
| Book em PDF | **Implementado** via impressão do navegador e endpoint com Chromium (Playwright) quando disponível |
| IA (descrição, lacunas, busca conversacional) | **Implementado** heurístico; usa a API da Anthropic se `ANTHROPIC_API_KEY` estiver definida |
| GA4, Meta Pixel/CAPI | **Pendente** — eventos já disparados no front via `dataLayer`, condicionados a consentimento |
| E-mail transacional | **Pendente** — reutilizar o módulo de E-mail Marketing (SES) |
| Assinatura eletrônica | **Pendente** |
| Validação de CRECI | **Pendente** (campo e status existem; a consulta ao COFECI precisa de convênio/API) |
| Storage S3 | **Pendente** — interface pronta, driver local em uso |
| SIGEF/INCRA e SICAR (WFS) | **Implementado** o adaptador (`integrations/territory.ts`): GetFeature WFS 1.1.0 por recorte, normalização de atributos, cache de 24 h em `territory_cache`. URLs e nomes de camada vêm do ambiente porque variam por serviço/UF. Sem configuração: **modo demonstração** com parcelas fictícias determinísticas, sempre rotuladas |
| Mapa do Registro de Imóveis (ONR) | O ONR não oferece API pública. **Implementado** link direto para conferência manual e adaptador para provedor contratado (`ONR_PROVIDER_URL`/`_TOKEN`, consulta por CAR/endereço). **Pendente** a contratação. A plataforma nunca trata o resultado como certidão |
| Google Earth | **Implementado**: link profundo `earth.google.com/web/@lat,lng,…` e exportação KML (estilo Dourado) para importar em projetos do Earth. O Earth Web não tem API de incorporação |
| Google 3D Maps (vista 3D fotorrealista) | **Implementado** `Map3DElement` + `Polygon3DElement`; **pendente** chave da Google Maps Platform com faturamento |

### Captação e dados territoriais

`land_prospects` é o funil anterior à área: nasce do mapa de prospecção (clique numa parcela SIGEF/CAR), de indicação de intermediador, do formulário "Tenho uma área" do site ou de cadastro manual. Cada prospecção guarda o *snapshot* territorial/registral consultado (fonte e data), checklist documental, base legal LGPD do contato do proprietário e uma pré-qualificação de 0 a 100 (demanda de compradores 40, documentos 25, identificação registral 15, contato 10, perímetro 10). A conversão cria a área em `captacao`, com origem registrada nas notas internas, perímetro, proprietário, potencial de uso como **declarado** e o intermediador indicador atribuído. Nada vindo de SIGEF/CAR/ONR é tratado como parâmetro urbanístico ou aprovação.

## 8. Plano de implementação

| Etapa | Conteúdo | Status |
|---|---|---|
| 1 | Fundação: migrations, auth, RBAC, auditoria, seed fictício | entregue |
| 2 | Cadastro de áreas em etapas, rascunho automático, geometria, documentos, mídia | entregue |
| 3 | Publicação com aprovação, portal público, filtros, mapa, página da área, book | entregue |
| 4 | Interesse → roteamento → CRM → WhatsApp; webhook; SLA | entregue |
| 5 | Negociações, propostas versionadas, comissões | entregue |
| 6 | Matching, dashboard, IA assistiva | entregue |
| 7 | Produção: CRM real, número WhatsApp oficial, S3, provedor de mapas, GA4/CAPI, assinatura eletrônica, CRECI | pendente |
