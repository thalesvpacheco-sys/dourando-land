# Manual operacional

Para a equipe Dourado: captação, administração e intermediadores.

## 1. Cadastrar uma área (captação)

1. **Banco de áreas → Cadastrar área.** Informe nome interno, tipo, UF e cidade. O código (ex.: `DOU-GO-0012`) é gerado na hora.
2. O cadastro tem 8 etapas e **salva sozinho** a cada alteração (veja "Rascunho salvo às…" no topo). Se aparecer "A área foi alterada por outra pessoa", clique em **Recarregar** antes de continuar — ninguém perde trabalho em silêncio.
3. **Localização e perímetro:** desenhe clicando nos vértices (clique duplo conclui) ou importe KML, KMZ, GeoJSON ou SHP compactado. Clique em **Salvar perímetro**. A área oficial do sistema é a calculada pelo PostGIS; cada salvamento cria uma versão.
4. **Urbanístico e técnico:** para cada parâmetro, preencha valor, **fonte**, data de consulta, responsável e status:
   - *Documento oficial* — certidão, diretriz ou aprovação emitida pelo órgão;
   - *Verificado* — conferido pela equipe;
   - *Declarado* — informado pelo proprietário;
   - *Não verificado* — sem checagem.
   O portal mostra o status ao lado de cada valor. Nunca marque como oficial o que não tem documento.
5. **Condições comerciais:** modalidades, valor, permuta, VGV e unidades (aparecem como "estimativa").
6. **Proprietários e documentos:** dados do proprietário ficam cifrados e nunca vão ao portal. Documentos têm classificação (público, interno, confidencial, restrito) e validade; **Nova versão** preserva o histórico.
7. **Imagens:** a primeira vira capa; metadados de localização das fotos são removidos.
8. **Responsável e publicação:** escolha o intermediador e o que o portal pode mostrar (valor, valor/m², precisão da localização, vitrine exclusiva). Para enviar à aprovação é preciso: título, tipo, cidade/UF, área, localização, imagem, modalidade, intermediador e **autorização de divulgação** (documento na categoria "Autorização de divulgação" ou base jurídica descrita).

## 2. Aprovar publicação (administrador)

**Aprovações** lista o que aguarda revisão. Abra a área, confira a etapa 7 e use **Aprovar e publicar** ou **Devolver para ajustes** (com observação). A área passa a "Disponível" e entra no portal. **Retirar do portal** despublica sem apagar nada.

## 3. Atender interesses (intermediadores)

- Cada clique em "Conversar pelo WhatsApp" gera um código `DL-XXXXXX`, que vai no fim da mensagem. **O clique não garante que a pessoa enviou a mensagem.** O status muda para "Mensagem recebida" quando o WhatsApp oficial confirma uma mensagem com o código.
- Interesses identificados (com nome e contato) abrem uma negociação em "Interesse recebido" e têm **prazo de primeiro atendimento** conforme a regra. A primeira atividade registrada na negociação marca o atendimento; também há o botão **Registrar primeiro atendimento**.
- Se a pessoa apagou a mensagem pré-preenchida, ela aparece em **Mensagens sem código de referência**. Vincule manualmente só quando tiver certeza de quem é.
- **Transferir atendimento** registra motivo e histórico.

## 4. Regras de encaminhamento (administrador)

Em **Atendimento e WhatsApp**: as regras são avaliadas por prioridade (menor primeiro) e podem enviar para o intermediador da área, para um rodízio ou para o número central. Intermediador inativo, sem WhatsApp ou com CRECI irregular é pulado. Atualize a situação do CRECI após consulta ao conselho regional.

## 5. Negociações e propostas

- O funil vai de *Interesse recebido* a *Conclusão*. Arraste os cartões ou mude a etapa no detalhe. Perda e suspensão exigem motivo.
- **Propostas** são versionadas: proposta do comprador, contraproposta do vendedor, novas versões. O aceite só é registrado depois da **aprovação interna** da versão atual.
- Quando uma negociação chega a *Proposta*, a área passa a "Em negociação".

## 6. Comissões (somente administrador)

Registre como **prevista**. Ela só avança assim:
- **Contratada:** com o contrato de intermediação anexado à área;
- **Exigível:** com a negociação em *Contrato* ou *Conclusão* e a descrição do evento contratual;
- **Paga:** com a data do pagamento.

Proposta ou cadastro não tornam comissão devida.

## 7. Compradores e matching

Cadastre a empresa e seus perfis de aquisição (cidades, metragem, tipologia, orçamento, permuta, estágio mínimo, restrições). O sistema pontua cada área de 0 a 100 e mostra **por que**: localização 25, metragem 20, tipologia 20, orçamento 15, modalidade 10, aprovação 10. Dados ausentes valem zero; dados não verificados reduzem o peso e baixam a confiança. Na etapa 8 da área, use **Sugerir mensagem** e **Marcar como apresentada**.

## 8. IA assistiva

Descrição comercial, pontos de atenção do cadastro, resumo da negociação, mensagem de WhatsApp e busca em linguagem natural. Tudo aparece como **sugestão**, com origem registrada, e precisa de revisão humana. A IA só usa dados cadastrados e não substitui análise jurídica ou técnica.

## 9. Privacidade

- Dados pessoais só entram com consentimento (formulários) ou outra base legal registrada (conversão manual).
- Pedido de exclusão: `POST /api/privacy/erase` (administrador) anonimiza interesses e negociações do titular; peça também a exclusão no WingsBr CRM.
- Exportações, downloads de documentos e mudanças relevantes ficam em **Auditoria**.

## 10. Alertas do painel

"Precisa de atenção" mostra: interessados fora do prazo, áreas aguardando aprovação, documentos que vencem em 30 dias e áreas sem atualização há mais de 30 dias.

## 11. Captação de novas áreas

1. **Prospecção no mapa** (Captação › Prospecção no mapa): aproxime o mapa até o nível de bairro/fazenda para carregar as camadas SIGEF/INCRA (linha preta) e CAR (tracejado verde). Clique numa parcela para ver código, área, situação e a consulta registral. Use "Abrir Mapa ONR" para conferir a matrícula no Mapa do Registro de Imóveis e "Google Earth" para ver o entorno.
2. **Criar prospecção**: o perímetro da parcela, os códigos SIGEF/CAR e a matrícula entram com a fonte e a data da consulta. Informe cidade e tipo.
3. **Funil de captação**: arraste a prospecção entre etapas. Registre ligações e visitas no histórico, preencha o contato do proprietário com a base legal e atualize o checklist documental.
4. **Pré-qualificação**: a nota de 0 a 100 mostra o porquê (demanda de compradores ativos, documentos, identificação registral, contato, perímetro). Priorize as áreas com demanda.
5. **Sobreposição**: "Analisar sobreposição" cruza o perímetro com SIGEF e CAR e mostra o percentual de cada imóvel. Serve para conferir a matrícula; não substitui certidões.
6. **Converter em área do banco** (captação ou administrador): exige UF, cidade, tipo, proprietário e localização. A área nasce em captação, não publicada, e segue o fluxo normal de cadastro, autorização e aprovação.
7. **Intermediadores** veem "Minhas indicações": a prospecção que indicam fica vinculada a eles e, na conversão, eles são atribuídos à área.
8. Proprietários que preenchem "Tenho uma área" no site entram automaticamente no funil, com consentimento registrado.

Em modo demonstração, parcelas e matrículas são fictícias e trazem o selo "fictício".
