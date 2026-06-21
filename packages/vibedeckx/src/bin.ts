#!/usr/bin/env node

// Must come first: load-env.js populates process.env from a .env file before any
// other module captures environment variables at import time.
import "./load-env.js";
import "./instrumentation.js";
import { run } from "@stricli/core";
import { program } from "./command.js";

run(program, process.argv.slice(2), { process });
