/**
 * File: main.tsx
 * Kegunaan: Entry point React DOM untuk merender aplikasi WindIsland.
 *
 * Satu halaman dipakai oleh tiga window Tauri:
 *   "main"     -> island (App)
 *   "settings" -> halaman Pengaturan (SettingsApp), dibuka dari tray / pemakaian pertama
 *   "radial"   -> menu radial di kursor saat file diseret (RadialOverlay), dibuat oleh Rust
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import SettingsApp from "./settings/SettingsApp";
import RadialOverlay from "./components/island/file/RadialOverlay";
import "./assets/styles/globals.css";

// Label window ("main" bila dijalankan di browser biasa tanpa Tauri)
function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

function Root() {
  switch (windowLabel()) {
    case "settings":
      return <SettingsApp />;
    case "radial":
      return <RadialOverlay />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
