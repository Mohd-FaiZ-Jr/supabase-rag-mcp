import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const config = loadConfig();
const app = createApp(config);
app.listen(config.port, "0.0.0.0", () => console.log(`banking-rag-mcp listening on port ${config.port}`));