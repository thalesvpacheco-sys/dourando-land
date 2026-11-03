# Mapa de navegação

## Portal público

```mermaid
flowchart LR
  H[Home<br/>mapa + busca] --> B[Banco de áreas<br/>/areas]
  H --> M[Mapa<br/>/mapa]
  H --> D
  B -->|lista ou mapa| D[Página da área<br/>/areas/:slug]
  M --> D
  D --> W{{Conversar pelo WhatsApp}}
  D --> F[Formulário de interesse]
  D --> K[Book / PDF<br/>/areas/:slug/book]
  D --> S[Semelhantes]
  H --> CF[Como funciona]
  H --> P[Para proprietários]
  H --> C[Para construtoras]
  H --> PA[Seja parceiro]
  H --> SO[Sobre]
  H --> CT[Contato e WhatsApp]
  W --> WA[(wa.me com código e token)]
  F --> CRM[(WingsBr CRM)]
  W --> CRM
```

## Painel (`/painel`) — menu por perfil

| Item | Admin Dourado | Captação | Intermediador | Proprietário | Comprador | Superadmin WingsBr |
|---|---|---|---|---|---|---|
| Visão geral (dashboard) | ✓ | ✓ (sem comissões) | Minha carteira | Minhas áreas | Recomendações | — |
| Banco de áreas / cadastro em 8 etapas | ✓ | ✓ | leitura (atribuídas) | leitura + envio de documentos | — | — |
| Aprovações de publicação | ✓ | — | — | — | — | — |
| Interesses (SLA, transferência, vínculo de mensagens) | ✓ | leitura | atribuídos | — | — | — |
| Negociações (funil arrastável, propostas, comissões) | ✓ | leitura | atribuídas | — | próprias (leitura) | — |
| Captação › Prospecção no mapa (SIGEF, CAR, ONR, Earth) | ✓ | ✓ | ✓ (leitura) | — | — | — |
| Captação › Funil de captação / Minhas indicações | ✓ | ✓ (converte em área) | indicações próprias | — | — | — |
| Compradores e matching | ✓ | ✓ | — | — | perfis próprios | — |
| Atendimento e WhatsApp (regras, intermediadores, número central) | ✓ | — | — | — | — | — |
| Usuários | ✓ | — | — | — | — | ✓ |
| Auditoria | ✓ | — | — | — | — | ✓ |
| Integrações | ✓ (leitura) | — | — | — | — | ✓ |

Etapas do cadastro da área: Identificação → Localização e perímetro → Urbanístico e técnico → Condições comerciais → Proprietários e documentos → Imagens → Responsável e publicação → Compradores compatíveis.
