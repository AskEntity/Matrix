import { createRoot } from "react-dom/client";
import { ShellApp } from "./ShellApp.tsx";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ShellApp />);
}
