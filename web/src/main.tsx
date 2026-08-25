import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./auth/useAuth.js";
import { App } from "./app/App.js";
import { initTheme } from "./theme.js";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
