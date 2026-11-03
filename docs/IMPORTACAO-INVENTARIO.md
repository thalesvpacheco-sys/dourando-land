# Importação e sincronização do inventário de áreas (Drive)

O inventário da Dourado Imob fica numa pasta do Google Drive ("GRANDES NEGÓCIOS"): uma subpasta por área, com KML/KMZ, um texto de oferta (.docx/.pptx), matrículas, projetos, fotos e vídeos. Há também uma pasta de controle com planilhas de captação, pipeline e pedidos de compradores.

O importador (`server/src/import`) transforma isso em áreas da plataforma, sem publicar nada, e pode rodar quantas vezes for preciso: ele só cria o que é novo e só atualiza o que mudou.

## Como cada pasta é lida

| Item | Regra |
|---|---|
| Unidade | Cada pasta de primeiro nível é uma área. Uma pasta sem KML próprio, com 2 ou mais subpastas que tenham KML ou texto (ex.: "Áreas Rubens Parceiro"), é tratada como agrupadora: cada subpasta vira uma área e o nome da agrupadora fica registrado. |
| Pasta de controle | Uma pasta só com planilhas e textos (ex.: "PROJETO ÁREAS") não vira área. Suas planilhas são lidas pelo cabeçalho. |
| Município e UF | Vêm do nome da pasta; se o nome não basta, do início do texto de oferta. Quando há mais de uma cidade no nome, vale a que aparece primeiro ("ITAÍ - SÃO PAULO" → Itaí/SP). A lista de municípios fica em `KNOWN_CITIES` (`extract.ts`). |
| Perímetro | Vem dos KML/KMZ. Polígonos são unidos no PostGIS (inclusive KMZ de urbanismo com centenas de lotes). Perímetros desenhados como linha no Google Earth são fechados em polígono. A área é a geodésica do PostGIS. |
| Texto de oferta | Vem dos .docx/.pptx da pasta. Dele saem área declarada, valor pedido, VGV, valor por lote, aporte, lotes e unidades, matrículas citadas, modalidades, estágio de aprovação e potencial de uso, cada um com o trecho de origem. |
| Alqueire | 48.400 m² (goiano/mineiro); 24.200 m² em SP, PR, SC e RS. |
| Valores ambíguos | "9.800 milhões" e "38.900.000.00 MILHÕES" são interpretados e marcados para conferência. Um "valor total" abaixo de R$ 500 mil, ou abaixo de R$ 1 milhão numa área acima de 1 ha, é tratado como preço unitário e não como preço da área. |
| Tipo da área | Inferido pela pasta e pelo texto, e editável na plataforma. Nomes de pasta com "LOGÍSTICA/GALPÃO", "VERTICAL" ou "ENERGIA" têm prioridade. Expressões como "logística da região" não fazem um loteamento virar área logística. |
| Documentos | São classificados pelo nome (matrícula, certidão/escritura, projeto/alvará, urbanístico, ambiental, planta, viabilidade…). Todos entram como **confidenciais**, e o texto de oferta original também fica guardado. |
| Fotos | Vão para a galeria (WebP). Vídeos e .zip (exportações do WhatsApp) não são importados e aparecem no relatório. |
| Planilhas | A aba Captações e o Pipeline são casados com as pastas por município (e por metragem, quando há várias pastas da mesma cidade). Cada linha casada vira nota no histórico. Pedidos e solicitações de compradores vão para o relatório como candidatos a perfis de aquisição. A aba de vendas residenciais é ignorada. |

## Destino

- **Área do banco**: quando a pasta tem município, UF, localização (perímetro ou ponto) e texto de oferta. A área entra em `captacao`, com publicação em rascunho e vitrine **privada**. Preço oculto e localização aproximada.
- **Funil de captação**: quando falta algo essencial. A prospecção entra com origem "Inventário importado (Drive)". Os documentos ficam pendentes e são anexados automaticamente quando a prospecção for convertida em área.
- Valores, aprovação e potencial de uso entram sempre como **declarado**. A publicação continua exigindo autorização de divulgação e aprovação de administrador.

## Reimportar e sincronizar

`import_items` guarda, para cada pasta, o hash do conteúdo e o retrato dos valores importados. Numa nova execução:

- **Pasta sem mudança:** nada acontece.
- **Pasta alterada:**
  - Atualiza só os campos que ninguém editou na plataforma desde a última importação. Se a equipe corrigiu um campo, o valor dela é mantido e o conflito vai para o relatório e para o histórico da área.
  - Um KML novo gera uma nova versão do perímetro, a não ser que ele tenha sido redesenhado na plataforma.
  - Um arquivo novo é anexado. Um arquivo com o mesmo caminho e conteúdo novo vira uma nova versão do documento.
- **Pasta que sumiu:** fica marcada como `missing`. Nada é apagado.

## Como rodar

```bash
# prévia (não grava nada) a partir de uma pasta local
npm run import:inventory -w server -- --dir "/caminho/GRANDES NEGÓCIOS" --org dourado --out previa.json

# aplicar (idempotente)
npm run import:inventory -w server -- --dir "/caminho/GRANDES NEGÓCIOS" --org dourado --user admin@dourado.com.br --apply --out aplicacao.json
```

Há também o formato `--package <dir>`: `manifest.json` (caminho, tamanho, data e sha256 de todos os arquivos) mais `files/` só com os arquivos leves. Ele serve para gerar a prévia sem copiar gigabytes de PDF e vídeo. Nesse modo os documentos não são anexados.

## Manter atualizado automaticamente

1. **Agora:** sincronize a pasta com o Google Drive para desktop no servidor (ou monte-a com rclone) e agende o comando com `--apply` (cron, a cada 6 h).
2. **Próximo passo (driver Drive API):** criar uma conta de serviço no Google Cloud e compartilhar a pasta com ela como leitora. A plataforma passa a listar a pasta pela API (`files.list` com `modifiedTime` e `md5Checksum`) e só baixa o que mudou. A interface `InventorySource` já está pronta para esse driver.
3. **Depois da migração:** com a equipe usando a plataforma, o Drive vira arquivo histórico e a sincronização é desligada.

## Primeira prévia real (02/11/2026)

A primeira prévia leu 922 arquivos em 119 pastas, que resultaram em 128 áreas: 85 vão para o banco e 43 para o funil, e 105 têm perímetro. Ela foi aplicada num banco isolado (`dourado_import`) e reaplicada sem gerar duplicatas. O relatório de revisão é a planilha `_PREVIA_IMPORTACAO_DOURADO_LAND.xlsx`, entregue ao cliente. **O inventário real nunca vai para o artifact de demonstração** (`export:demo` usa só o banco `dourado`, que tem apenas o seed fictício).
