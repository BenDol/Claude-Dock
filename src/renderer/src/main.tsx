import React from 'react'
import ReactDOM from 'react-dom/client'
import './global.css'

// Plugin registrations must run before App import
import './plugins'

import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
