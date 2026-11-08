/**
 * File: main.tsx
 * Kegunaan: Entry point React DOM untuk merender aplikasi WindIsland.
 *
 * Satu halaman dipakai oleh dua window Tauri:
 *   "main"     -> island (App)
 *   "settings" -> halaman Pengaturan (SettingsApp), dibuka dari tray / pemakaian pertama
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import SettingsApp from "./settings/SettingsApp";
import "./assets/styles/globals.css";

// Label window ("main" bila dijalankan di browser biasa tanpa Tauri)
function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {windowLabel() === "settings" ? <SettingsApp /> : <App />}
  </React.StrictMode>,
);