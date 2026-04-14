import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const el = document.getElementById("app");
if (el) createRoot(el).render(<App />);
