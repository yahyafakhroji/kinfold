import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme, readTheme } from './lib/theme'
import { makeRouter, queryClient } from './router'
import './styles.css'

// Before the first render, so the page never flashes the other theme.
applyTheme(readTheme())

const router = makeRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
