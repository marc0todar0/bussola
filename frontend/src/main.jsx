import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { loadConfig } from './utils/runtimeConfig'
import { detect, loadCatalogue } from './i18n'

// The config comes from /config.json: it has to be resolved before the app's
// first fetch. The catalogue of the language the reader will see first comes
// alongside, so that the first frame is not English for a moment.
Promise.all([loadConfig(), loadCatalogue(detect())]).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
