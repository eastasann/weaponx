import { createApp } from "./app";
import { loadConfig } from "./lib/config";

const config = loadConfig();
createApp(config).listen(config.port);
console.log(JSON.stringify({ severity: "INFO", message: "api started", port: config.port }));
