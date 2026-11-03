// Teste e2e no navegador (Playwright). Pré-requisitos: API em :4200 e web em :5174 com o seed de demonstração.
// Uso: node e2e/fluxo-principal.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const WEB = process.env.WEB_URL ?? 'http://localhost:5174';
const API = process.env.API_URL ?? 'http://localhost:4200';
const step = (s) => console.log('✓', s);

const browser = await chromium.launch();
try {
  // ------------------------------------------------ visitante
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${WEB}/?utm_source=google&utm_medium=cpc&gclid=E2E123`);
  await page.getByRole('heading', { name: 'Terra certa para o próximo empreendimento' }).waitFor();
  step('home carregou com o mapa e a busca');

  await page.getByLabel('Finalidade').selectOption('loteamento');
  await page.getByRole('button', { name: 'Ver áreas compatíveis' }).click();
  await page.waitForURL(/\/areas\?viability=loteamento/);
  await page.locator('.ficha').first().waitFor();
  await page.waitForTimeout(500);
  const n = await page.locator('.ficha').count();
  assert.ok(n >= 2, 'deveria haver ao menos 2 áreas para loteamento');
  step(`banco de áreas filtrado por finalidade: ${n} resultados`);

  await page.getByRole('button', { name: 'Permuta física' }).click();
  await page.waitForURL(/modality=permuta_fisica/);
  step('filtro combinável aplicado pela URL');

  await page.locator('.ficha').filter({ hasText: 'Senador Canedo' }).click();
  await page.getByRole('heading', { level: 1, name: /Senador Canedo/ }).waitFor();
  const body = await page.locator('main').innerText();
  assert.ok(!/Propriet[aá]rio Fict[ií]cio|Agropecu[aá]ria Fict/.test(body), 'dados do proprietário não podem aparecer');
  assert.ok(body.includes('Sob consulta'), 'preço oculto deve aparecer como sob consulta');
  step('página da área sem dados confidenciais');

  await page.getByRole('button', { name: 'Conversar pelo WhatsApp' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Conversar pelo WhatsApp' });
  await dialog.getByLabel('Nome').fill('Teste E2E');
  await dialog.getByLabel('Telefone com DDD').fill('(62) 98111-2233');
  // sem consentimento: deve bloquear
  await dialog.getByRole('button', { name: 'Enviar dados e abrir WhatsApp' }).click();
  await dialog.getByText('marque a autorização').waitFor();
  await dialog.getByRole('checkbox').check();
  const popupPromise = ctx.waitForEvent('page');
  await dialog.getByRole('button', { name: 'Enviar dados e abrir WhatsApp' }).click();
  const popup = await popupPromise;
  await dialog.getByText('A mensagem já leva o código da área').waitFor();
  const quote = await dialog.locator('blockquote').innerText();
  assert.match(quote, /DOU-GO-0004 — Gleba para loteamento aberto em Senador Canedo, localizada em Senador Canedo\/GO, com área de 42 ha\. .*Referência: DL-[A-Z0-9]{6}\./);
  const waLink = await dialog.getByRole('link', { name: 'Abrir WhatsApp' }).getAttribute('href');
  assert.match(waLink, /^https:\/\/wa\.me\/5562999110001\?text=/);
  await popup.close();
  const token = quote.match(/DL-[A-Z0-9]{6}/)[0];
  step(`WhatsApp com contexto correto e token ${token}`);

  // ------------------------------------------------ administração
  const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ap = await admin.newPage();
  ap.on('pageerror', (e) => errors.push(e.message));
  await ap.goto(`${WEB}/painel/entrar`);
  await ap.getByRole('button', { name: /Marina Albuquerque/ }).click();
  await ap.getByRole('heading', { name: 'Visão geral' }).waitFor();
  step('login de demonstração como administradora');

  await ap.goto(`${WEB}/painel/interesses`);
  const row = ap.locator('tr', { hasText: token });
  await row.waitFor();
  assert.ok((await row.innerText()).includes('Teste E2E'));
  assert.ok((await row.innerText()).includes('google_ads'), 'atribuição de origem (gclid) registrada');
  await row.click();
  const drawer = ap.getByRole('dialog', { name: `Interesse ${token}` });
  await drawer.getByText('Registrado no CRM WingsBr').waitFor();
  step('interesse registrado no CRM e encaminhado à intermediadora');
  await drawer.getByRole('link', { name: 'Abrir negociação' }).click();
  await ap.getByRole('dialog', { name: 'Teste E2E' }).waitFor();
  step('negociação aberta automaticamente na etapa Interesse recebido');

  await ap.goto(`${WEB}/painel/aprovacoes`);
  await ap.getByRole('link', { name: 'DOU-GO-0007' }).click();
  await ap.getByRole('button', { name: 'Responsável e publicação' }).click();
  await ap.getByRole('button', { name: 'Aprovar e publicar' }).click();
  await ap.getByText('Área publicada').waitFor();
  step('área aprovada pelo administrador');

  const pub = await (await fetch(`${API}/api/public/opportunities?q=DOU-GO-0007`)).json();
  assert.equal(pub.total, 1, 'área recém-aprovada deve aparecer na vitrine');
  step('área publicada aparece na busca pública');

  assert.deepEqual(errors, [], `erros de JavaScript: ${errors.join(' | ')}`);
  step('nenhum erro de JavaScript');
  console.log('\nFluxo principal OK');
} finally {
  await browser.close();
}
