import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Il .env sta alla radice del progetto, condiviso con docker compose.
  const env = loadEnv(mode, '../', '')

  // Dalla Fase 1 il frontend non conosce nessuna credenziale: l'identità sta in
  // un cookie di sessione httpOnly, che il JavaScript non può nemmeno leggere.
  // Resta solo l'indirizzo della API, e in produzione arriva da /config.json.
  //
  // __DEMO__ is the public demo (VITE_DEMO=1 yarn build:demo): the API is
  // replaced by an in-browser copy (src/demo/). A literal true or false, so
  // that in the real build every `if (__DEMO__)` is dead code and the demo
  // does not reach the bundle at all.
  // loadEnv with an empty prefix includes the process environment too.
  const demo = env.VITE_DEMO === '1'
  const define = {
    __DEMO__: JSON.stringify(demo),
  }

  return {
    plugins: [react()],
    envDir: '../',
    define,
    server: {
      host: true, // Or use '0.0.0.0'
      port: 5173,
      // Stessa origine anche in sviluppo: /api viene inoltrato all'API locale,
      // quindi il browser non fa mai richieste cross-origin (niente CORS).
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: true,
          // changeOrigin rewrites Host to the API's own address, so the API
          // could no longer tell that a POST from http://localhost:5173 came
          // from its own pages and would refuse it (auth/middleware.js,
          // sameOrigin). xfwd passes the original Host as X-Forwarded-Host,
          // and the client address as X-Forwarded-For, as nginx does.
          xfwd: true,
        },
      },
    },
  }
})
