# Publicação na Hostinger via Git (branch `main`)

## O que é publicado
A pasta **`/site`** (versão estática: front React + backend **simulado no navegador** com dados fictícios).
O `.htaccess` da raiz reescreve tudo para `/site`, força HTTPS e impede o acesso ao código-fonte (`server`, `web`, `shared`, `docs`, `.git`).

> A API real (Node + PostgreSQL/**PostGIS**) **não roda em hospedagem compartilhada** (a Hostinger só oferece MySQL lá). Para a plataforma completa é preciso VPS (ver `MANUAL-DE-IMPLANTACAO.md`).

## Passo a passo
1. Atualize o site quando mudar o front: `npm run build:site` e faça commit da pasta `site/`.
2. Primeiro envio ao GitHub:
   ```bash
   git remote add origin https://github.com/thalesvpacheco-sys/dourando-land.git   # já configurado
   git push -u origin main
   ```
3. hPanel → **Websites → Gerenciar → Avançado → Git**: repositório `https://github.com/thalesvpacheco-sys/dourando-land.git`, branch `main`, diretório de instalação **em branco** (= `public_html`). Se o repositório for privado, adicione a chave SSH de implantação mostrada no hPanel em *Settings → Deploy keys* do GitHub.
4. Ative o **auto deploy** (webhook do GitHub) para publicar a cada push em `main`.
5. SSL: hPanel → Segurança → SSL (Let's Encrypt/gratuito) antes de forçar HTTPS.
6. Confira: `/`, `/areas`, recarregar em `/areas/<slug>` (deve abrir, não dar 404) e `/painel/entrar`.

## Antes de divulgar
- `robots.txt` bloqueia indexação (dados fictícios). Troque `deploy/robots.txt` e rode `npm run build:site` quando houver dados reais.
- Número central de WhatsApp (`web/src/public/Layout.tsx`, `5562900000000`) e dados do seed são **fictícios**.
- O painel está aberto a qualquer visitante (login de demonstração, sem senha): não coloque dados reais nele.
- Com `VITE_DEMO_BAR=1` em `web/.env.static` a barra de testes volta a aparecer.
