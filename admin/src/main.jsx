import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AdminApp from './AdminApp.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>
);
