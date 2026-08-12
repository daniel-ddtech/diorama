#!/usr/bin/env node
import { createServer } from "./server.js";
import { createToolRegistry } from "./tools.js";

await createServer({ tools: createToolRegistry() }).start();
