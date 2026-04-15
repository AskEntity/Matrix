// Save Bun's real fetch BEFORE happy-dom overwrites it
const _bunFetch = globalThis.fetch;

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// Restore Bun's real fetch — happy-dom's fake one breaks HTTP in other test files
globalThis.fetch = _bunFetch;

// Verify
if (globalThis.fetch.name === "bound fetch") {
	throw new Error("FATAL: happy-dom fetch not restored!");
}
