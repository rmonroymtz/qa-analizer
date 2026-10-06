#!/usr/bin/env node
import { runCli } from './run-cli.js';

runCli(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Last resort: the use case never throws, so this is a wiring bug. Print only the message.
    process.stderr.write(`[qa-analyzer] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
