/**
 * File: main.tsx
 * Kegunaan: Entry point React DOM untuk merender aplikasi WindIsland.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./assets/styles/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
