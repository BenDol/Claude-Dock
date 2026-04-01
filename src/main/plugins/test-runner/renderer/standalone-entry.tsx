import React from 'react'
import { createRoot } from 'react-dom/client'
import '@dock-renderer/global.css'
import './test-runner.css'
import TestRunnerApp from './TestRunnerApp'

const root = createRoot(document.getElementById('root')!)
root.render(<TestRunnerApp />)
