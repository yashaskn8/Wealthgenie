import React from 'react';
import { createRoot } from 'react-dom/client';
import CashCheck from '../src/components/CashCheck.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><CashCheck /></React.StrictMode>,
);
