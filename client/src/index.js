import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import axios from 'axios';

// Configure axios to send credentials (cookies) with all requests
axios.defaults.withCredentials = true;
// Only set baseURL if explicitly provided (for production), otherwise use proxy
if (process.env.REACT_APP_SERVER_URL) {
  axios.defaults.baseURL = process.env.REACT_APP_SERVER_URL;
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);