import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DemoBanner from './components/DemoBanner';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoBanner />
    <App />
  </StrictMode>,
);
