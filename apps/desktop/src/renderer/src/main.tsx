import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@renderer/App";
import { applyStoredTheme } from "@renderer/vault/useSettings";
import "@renderer/styles.css";

// Paint the saved theme onto <html> before the first render so there's no
// dark-then-light flash on launch (CSP blocks an inline script in index.html).
applyStoredTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
