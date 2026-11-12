# Dourado Land Intelligence

Plataforma de oportunidades imobiliárias (glebas e terrenos para incorporação, loteamento e desenvolvimento) operada pela Dourado Real Estate Partners e integrada à WingsBr.

- **Portal público:** home com mapa, banco de áreas com filtros combináveis, mapa de oportunidades com comparação, página da área com WhatsApp contextual, book em PDF e páginas institucionais.
- **Painel:** dashboard, cadastro de áreas em 8 etapas com rascunho automático, perímetro em PostGIS, documentos versionados, aprovação de publicação, interesses com SLA, funil de negociações, propostas versionadas, comissões, matching explicável, regras de WhatsApp, auditoria e integrações.

Stack: Node + TypeScript, Express, Knex, PostgreSQL + PostGIS, React + Vite, MapLibre. A mesma base dos módulos de E-mail Marketing e WingsBr Pages.

```
shared/   vocabulário, matching determinístico, mensagem do WhatsApp
server/   API, migrations, seed fictício, worker (outbox CRM), testes
web/      portal público e painel
e2e/      teste de navegador do fluxo principal
docs/     arquitetura, modelo de dados, API, navegação, manuais
```

**Publicar em produção:** veja `docs/PUBLICAR.md`. Início rápido local: veja `docs/MANUAL-DE-IMPLANTACAO.md` (`npm install`, `npm run migrate`, `npm run seed`, `npm run dev -w server`, `npm run dev -w web`).

## Demonstração (backend simulado)

`npm run seed && npm run export:demo -w server && npm run build:demo -w web` gera `web/dist-demo/`: a mesma interface com um **backend simulado no navegador** (`web/src/demo/mockServer.ts`) que reaproveita as regras reais do servidor (`server/src/auth/permissions.ts`, `server/src/domain/views.ts`, `server/src/domain/ai-heuristics.ts`, matching e mensagem do WhatsApp em `shared/`). Inclui barra de teste: trocar de perfil, simular a mensagem do WhatsApp chegando pelo webhook e restaurar os dados. Os dados ficam só no navegador de quem testa.

## O que está implementado, simulado ou pendente

| Área | Situação |
|---|---|
| Login próprio: convite, senha (scrypt), duas etapas (TOTP) obrigatórias para administradores, códigos de recuperação, bloqueio por tentativas, cookie HttpOnly, revogação de sessão, gestão de usuários | Implementado e testado (`auth.test.ts`) |
| Login por seletor de usuários | **Somente demonstração e desenvolvimento** (`ENABLE_DEV_LOGIN=true`; nunca com `NODE_ENV=production`) |
| Integração com a identidade WingsBr | Não usada nesta versão; o formato de token continua compatível, mas sem provisionamento automático em produção |
| RBAC por papel × organização × oportunidade; IDOR → 404; isolamento entre organizações | Implementado e testado |
| Cadastro em etapas, rascunho automático com bloqueio otimista | Implementado |
| PostGIS: perímetro versionado, área/perímetro geodésicos, ponto público ofuscado, busca por região | Implementado |
| Importação KML, KMZ, GeoJSON, SHP (.zip) e desenho/edição de perímetro | Implementado |
| Documentos com versão, validade, classificação, URL temporária, auditoria; uploads checados por assinatura | Implementado |
| Publicação com autorização de divulgação + aprovação de administrador | Implementado |
| Vitrine pública e privada, filtros combináveis, mapa com agrupamento, página da área, semelhantes, favoritos, compartilhamento | Implementado |
| Book digital e PDF | Implementado (impressão no navegador; PDF no servidor quando há Chromium) |
| Interesse → token → roteamento (atribuído, rodízio, central) → CRM → WhatsApp com mensagem contextual; SLA; transferência | Implementado |
| Webhook WhatsApp Business Platform (assinatura, idempotência, conversa iniciada, mensagem recebida, vínculo manual) | Implementado; **pendente** app e número oficiais da Dourado |
| WingsBr CRM / Leads Hub | Adaptador HTTP com HMAC, idempotência e outbox **implementado**; sem `WINGSBR_CRM_URL` roda em **modo embutido simulado** |
| Negociações (várias por área), atividades, propostas versionadas com aprovação interna, comissões com máquina de estados | Implementado |
| Matching determinístico explicável | Implementado |
| IA: descrição, lacunas, resumo, mensagem, busca conversacional | Heurísticas determinísticas **implementadas**; com `ANTHROPIC_API_KEY` usa o Claude para redação |
| Dashboard com dados persistidos e alertas | Implementado |
| LGPD: consentimento, base legal, IP como hash, anonimização a pedido, retenção | Implementado |
| Mapa: provedor licenciado (ruas, rodovias, satélite) | Seletor satélite/mapa **implementado**; **pendente** contrato com o provedor (`VITE_SATELLITE_TILES`) |
| Storage S3, Redis para cluster, GA4/Meta CAPI, e-mail transacional, assinatura eletrônica, consulta automática de CRECI | **Pendente** |
| Identidade visual Dourado (logotipo, preto e dourado, Bebas Neue + Archivo) | Implementado |
| Captação de novas áreas: mapa de prospecção, funil, pré-qualificação por demanda de compradores, checklist documental, conversão em área | Implementado e testado (`captacao.test.ts`) |
| Bases territoriais (SIGEF, SNCI, CAR e temas, restrições) carregadas no PostGIS por `territory:import`; adaptador WFS como alternativa | **Implementado** e testado com shapefiles fictícios (`territorio.test.ts`); **pendente** carregar os arquivos oficiais e conferir os nomes de campo |
| Busca por CAR, certificação, matrícula, nome e coordenadas (decimal, GMS, UTM); ficha da parcela com KML e DXF; medição | Implementado |
| Análise ambiental (área aproveitável pela união de APP, RL, hidrografia e uso restrito) e alertas de restrição | Implementado; depende das bases carregadas |
| Radar de captação (parcelas por critério ou perfil de aquisição, sem as já cadastradas) | Implementado; depende das bases carregadas |
| Leitura de matrícula por IA | **Implementado**, testado com resposta simulada; **pendente** `ANTHROPIC_API_KEY` e validação com matrículas reais |
| Mapa do Registro de Imóveis (ONR) | **Sem API pública.** Link direto ao Mapa **implementado**; consulta de matrícula por **provedor contratado** (adaptador pronto, `ONR_PROVIDER_URL`) — **pendente** contrato |
| Importação do inventário (pastas do Drive): perímetro, texto de oferta, documentos, fotos, planilhas de controle; reimportação idempotente que preserva edições | **Implementado** e testado (`importacao.test.ts`; ver `docs/IMPORTACAO-INVENTARIO.md`). Leitura de pasta local/sincronizada; driver Drive API **pendente** |
| Google Earth | **Implementado**: abrir a área no Earth Web e exportar KML para projetos do Earth |
| Vista 3D integrada (Google 3D Maps) | **Implementado** no código; **pendente** chave faturada `VITE_GOOGLE_MAPS_API_KEY` |

Todos os nomes, documentos, telefones, áreas e imagens do seed são **fictícios**. As imagens são ilustrações geradas, marcadas como "Imagem ilustrativa".

## Critérios de aceite (seção 20) → testes

| Critério | Teste |
|---|---|
| Administrador cadastra área com imagens, condições e localização | `acceptance.test.ts` §1 |
| Área passa por aprovação e é publicada | §2, §2b, e2e |
| Visitante pesquisa e filtra | §3, e2e |
| Visitante vê a página individual | §4, e2e |
| Campos confidenciais respeitados | §5, §12, e2e |
| WhatsApp com contexto correto | §6, e2e |
| Interesse registrado no CRM | §7, e2e |
| Intermediador recebe conforme regra | §8 |
| Equipe acompanha a negociação | §9, e2e |
| Proposta cadastrada e versionada | §10 |
| Dashboard reflete dados persistidos | §11 |
| Permissões impedem acesso indevido | §12 (intermediador, proprietário, comprador, outra organização, superadmin, documentos, MFA, upload malicioso) |
| Fluxos principais com testes automatizados | 75 testes de API (27 de aceite + 11 de captação + 10 de importação + 14 de login + 13 territoriais) + e2e de navegador |

## Publicação

- **Demonstração (atual, Hostinger via Git):** `npm run build:site` gera `/site`, o site estático com backend simulado e URLs reais. Veja `docs/DEPLOY-HOSTINGER.md`.
- **Produção (VPS com Docker):** API + portal + PostGIS + HTTPS com `docker compose up -d --build`. Veja `docs/PUBLICAR.md`.
