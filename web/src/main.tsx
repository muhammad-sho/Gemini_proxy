import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./auth/useAuth.js";
import { App } from "./app/App.js";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
