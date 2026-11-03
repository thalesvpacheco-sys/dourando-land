// Gera /site (o que a Hostinger serve) a partir do front com backend simulado.
// Uso: npm run build:site   → depois: git add -A && git commit && git push origin main
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

run('npm run build:static -w web');
const site = path.join(root, 'site');
fs.copyFileSync(path.join(root, 'deploy/site.htaccess'), path.join(site, '.htaccess'));
if (!fs.existsSync(path.join(site, 'robots.txt')) || process.env.KEEP_ROBOTS !== '1') {
  fs.copyFileSync(path.join(root, 'deploy/robots.txt'), path.join(site, 'robots.txt'));
}
// 404 estático: o fallback do .htaccess serve index.html; o arquivo abaixo cobre servidores sem rewrite
fs.copyFileSync(path.join(site, 'index.html'), path.join(site, '404.html'));
console.log('\nSite gerado em /site. Faça commit dessa pasta junto com o código.');
