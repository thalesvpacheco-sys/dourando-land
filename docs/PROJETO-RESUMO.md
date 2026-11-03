# Dourado Land Intelligence: decisões e arquitetura (nov/2026)

## Contexto
Plataforma de oportunidades de áreas para incorporação e loteamento, operada pela Dourado Real Estate Partners e integrada à WingsBr. O repositório da WingsBr não estava acessível, então o módulo usa a mesma stack dos módulos de E-mail Marketing e WingsBr Pages:
- Node + TypeScript, Express, Knex e React + Vite;
- JWT HS256 emitido pela WingsBr;
- **PostgreSQL + PostGIS obrigatório**, inclusive em desenvolvimento;
- MapLibre 6 para mapas.

Menus: portal público em `/` e painel em `/painel`.

## Decisões-chave
- **Não existe um segundo CRM.** Contatos, leads, negócios e atividades vão ao WingsBr CRM/Leads Hub por outbox (`crm_outbox`, HMAC, Idempotency-Key, 8 tentativas). Sem `WINGSBR_CRM_URL`, roda em modo embutido simulado (`crm_contacts`).
- **Publicação:** cadastro não é publicação. Exige autorização de divulgação (documento ou base jurídica) e aprovação de administrador. A visibilidade pode ser pública ou privada (vitrine só para parceiros logados).
- **Confidencialidade:** a visão pública (`publicView`) e a interna (`internalView`) seguem uma matriz papel × recurso × escopo (org, assigned, own, published).
  - Essas regras ficam em `server/src/domain/views.ts`, um módulo puro, sem banco.
  - Acesso fora do escopo responde 404, para não revelar a existência do registro (proteção contra IDOR).
  - O comprador usa `dataOrgId`, a organização gestora, para enxergar perfis e negociações.
- **Geo:**
  - perímetro versionado em MultiPolygon 4326;
  - área e perímetro calculados em geography;
  - ponto público ofuscado de forma determinística;
  - precisão exibida no portal: exata, aproximada (cerca de 1,2 km) ou região (cerca de 6 km);
  - importação de KML, KMZ, GeoJSON e SHP (.zip).
- **WhatsApp:**
  - token `DL-XXXXXX` incluído na mensagem;
  - status separados para clique, conversa iniciada e mensagem recebida (via webhook com assinatura);
  - mensagens sem token ficam para vínculo manual;
  - roteamento por regras: intermediador atribuído, rodízio ou central, com SLA.
- **Comissão:** só avança prevista → contratada (com contrato) → exigível (etapa Contrato/Conclusão + evento) → paga. Proposta não gera comissão devida.
- **Matching:** determinístico e explicável. Pesos: localização 25, metragem 20, tipologia 20, orçamento 15, modalidade 10, aprovação 10. Dado ausente vale 0; dado não verificado reduz o peso.
- **IA:** heurística por padrão (`server/src/domain/ai-heuristics.ts`); usa o Claude se `ANTHROPIC_API_KEY` estiver definida. Toda saída é rotulada como sugestão e gravada em `ai_suggestions`.

## Identidade visual Dourado (aplicada)
- Logotipo oficial enviado pelo cliente: símbolo e assinatura "DOURADO / REAL ESTATE PARTNERS" (`web/public/brand/`), com versão clara para fundos escuros.
- Cores: preto `#0a0a0a`, dourado `#f8b817` (hover `#f2ae30`, profundo `#cc9814`, texto `#7a5800`, suave `#fdf1cc`), papel `#f5f5f3`, verde cerrado `#2f7d4f` para estados positivos.
- Tipografia: Bebas Neue nos títulos (sem negrito falso) e Archivo no texto.
- Hero, rodapé e menu lateral em preto; perímetros dourados com contorno preto; marcadores dourados com texto preto.

## Captação de novas áreas
- Tabela `land_prospects` (migração 002): funil anterior à área, com código `CAP-AAAA-NNNN`.
- Etapas: identificada → contato → documentação → análise → proposta de intermediação → contratada; descarte com motivo.
- Origens: mapa de prospecção, indicação de intermediador ("Minhas indicações"), formulário "Tenho uma área" do site (consentimento) e cadastro manual.
- Pré-qualificação 0–100: demanda de compradores 40, documentos 25, identificação registral 15, contato do proprietário 10, perímetro 10.
- Checklist documental: matrícula, CCIR/CAR, IPTU/ITR, certidão, planta, autorização de divulgação, contrato de intermediação.
- A conversão (captação ou administrador) cria a área em `captacao`, não publicada; o potencial de uso entra como **declarado** e o intermediador indicador é atribuído.

## Dados territoriais e registrais
- **Mapa do Registro de Imóveis (ONR)** (mapa.onr.org.br): não tem API pública. A plataforma oferece um link direto para conferência e um adaptador para um provedor contratado (`ONR_PROVIDER_URL`/`_TOKEN`). O resultado nunca é tratado como certidão.
- **SIGEF/INCRA e SICAR:** adaptador WFS 1.1.0 com cache de 24 h (`territory_cache`). URLs e nomes de camada vêm do ambiente; confirme com `GetCapabilities`.
- A sobreposição PostGIS do perímetro com os imóveis mostra a porcentagem da área e a do imóvel.
- **Modo demonstração** (`TERRITORY_MODE=demo`, padrão fora de produção): parcelas e matrículas fictícias e determinísticas, sempre com o selo "fictício".

## Importação do inventário (Drive "GRANDES NEGÓCIOS")
- `server/src/import` faz a importação: `extract.ts` (regras puras), `plan.ts` (o que cada pasta vira), `apply.ts` (gravação idempotente) e `sources.ts` (pasta local ou pacote manifesto).
- Comando: `npm run import:inventory -w server -- --dir <pasta> [--apply]`.
- Cada pasta vira uma área do banco (captação, rascunho, vitrine privada) ou uma prospecção no funil, quando falta município, UF, localização ou texto.
- Pastas de parceiro com subpastas são separadas em várias áreas.
- Perímetros desenhados como linha no Earth são fechados; os KMZ de urbanismo são unidos no PostGIS.
- Valores, aprovação e uso entram como "declarado", com o trecho de origem nas notas internas.
- Os documentos entram como confidenciais.
- Planilhas de controle:
  - Captações e Pipeline viram notas no histórico da área;
  - pedidos de compradores vão para o relatório;
  - a aba de vendas residenciais é ignorada.
- Reimportar não duplica: a importação atualiza só os campos que a equipe não editou e registra os conflitos.
- Primeira prévia real (02/11/2026): 922 arquivos, 128 áreas (85 no banco, 43 no funil), 105 com perímetro. Foi testada num banco isolado e reaplicada sem duplicatas.
- O relatório `_PREVIA_IMPORTACAO_DOURADO_LAND.xlsx` está na pasta do cliente.
- O inventário real **nunca** vai para o artifact de demonstração.
- Pendente:
  - definir o servidor de produção;
  - criar a conta de serviço do Google para a sincronização automática (driver Drive API);
  - revisar a planilha com a equipe.

## Google Earth
- O Earth Web não tem API de incorporação.
- Botão "Abrir no Google Earth" (link profundo com a câmera sobre a área) e exportação KML no estilo Dourado para importar em projetos do Earth.
- Vista 3D fotorrealista integrada via Google 3D Maps (`Map3DElement` + `Polygon3DElement`): já implementada; depende de `VITE_GOOGLE_MAPS_API_KEY`, chave faturada pela Google.

## Demonstração para testes (artifact)
- Link: https://claude.ai/artifact/Md5pFwjBmLCKq54oKqojhS (compartilhado publicamente pelo dono).
- Usa a mesma interface com um backend simulado no navegador (`web/src/demo/mockServer.ts`). O simulador reaproveita a matriz de permissões, as visões, o matching, a mensagem do WhatsApp, as heurísticas, a pré-qualificação e as parcelas fictícias reais. A sobreposição é calculada com turf.
- A barra de teste troca o perfil, simula o WhatsApp e segue um roteiro que inclui captação e Earth. Ela se recolhe sozinha no mapa de prospecção.
- Os dados ficam só no navegador de quem testa.
- Como gerar: `npm run seed && npm run export:demo -w server && npm run build:demo -w web` (saída em `web/dist-demo`; o export também copia `brand/`).
- Limites do frame:
  - sem downloads (o CSV e o KML vão para a área de transferência);
  - sem impressão do book e sem abertura automática do WhatsApp;
  - sem vista 3D, porque scripts externos são bloqueados.

## Validação
- 48 testes de API (10 deles de importação do inventário): 27 de aceite (permissões, isolamento, webhook, geo, comissões, matching, IA, LGPD) e 11 de captação (funil, escopo do intermediador, territorial, sobreposição, KML, conversão, formulário do proprietário).
- 1 teste e2e de navegador (busca → área → WhatsApp → CRM → negociação → aprovação).
- Fluxo de captação verificado no build de demonstração, sem erros de JavaScript.

## Pendências para produção
- URL e segredo do CRM real.
- App e número oficiais do WhatsApp.
- Provedor cartográfico licenciado (`VITE_MAP_STYLE_URL`, satélite).
- URLs e camadas WFS de SIGEF e SICAR.
- Servidor de produção e conta de serviço do Google para sincronizar o inventário do Drive.
- Contrato com provedor de consulta registral (ONR).
- Chave da Google Maps Platform para a vista 3D.
- Storage S3 e Redis para cluster.
- GA4 e Meta CAPI.
- E-mail transacional (reutilizar SES).
- Assinatura eletrônica.
- Consulta automática de CRECI.
