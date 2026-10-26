import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadConfig } from "./config";
import "./index.css";

// Config first (modules, timezone), so pages of disabled modules never flash up.
// loadConfig never throws and gives up after 3 s – then every module counts as on.
void loadConfig().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
