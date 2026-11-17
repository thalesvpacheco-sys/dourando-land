import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:4200';

/**
 * Modos de build:
 *  - (padrão)  `vite build`              → web/dist        — front real, conversa com a API em /api
 *  - demo      `vite build --mode demo`  → web/dist-demo   — demonstração em frame: caminhos relativos, rota em memória
 *  - static    `vite build --mode static`→ /site           — site publicável (Hostinger via git): URLs reais, backend simulado no navegador
 */
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  const site = mode === 'static';
  return {
    plugins: [react()],
    // MapLibre 6 carrega o worker por URL relativa ao módulo; o pré-empacotamento do Vite quebraria esse caminho
    optimizeDeps: { exclude: ['maplibre-gl'] },
    base: demo ? './' : '/',
    publicDir: demo || site ? 'demo-public' : 'public',
    build: {
      outDir: site ? '../site' : demo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1600,
      assetsInlineLimit: demo ? (file: string) => (/\.woff2?$/.test(file) ? true : undefined) : undefined,
    },
    // demo/static simulam a API no navegador e servem /media de demo-public: sem proxy, senão as fotos voltam 502 sem a API local
    server: { port: 5174, host: true, proxy: demo || site ? undefined : { '/api': api, '/media': api, '/webhooks': api } },
    preview: { port: 5174, proxy: { '/api': api, '/media': api } },
  };
});
