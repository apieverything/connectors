"use strict";

/**
 * Minimal .env loader with hot-reload support.
 *
 * Node's `--env-file` only reads the file once at process start. This module
 * re-reads it on Ctrl+R so editing .env takes effect without a restart.
 *
 * Values coming from the real process environment (e.g. `PORT=4000 node ...`)
 * are detected on first load and treated as explicit overrides: they are never
 * overwritten by a reload. Everything else is re-applied from the file.
 */

const fs = require("node:fs");
const path = require("node:path");

function parseEnvFile(text) {
  const entries = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (!key) continue;

    const doubleQuoted = value.startsWith('"') && value.endsWith('"');
    const singleQuoted = value.startsWith("'") && value.endsWith("'");
    if (doubleQuoted || singleQuoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();

    entries.set(key, value);
  }
  return entries;
}

class Config {
  constructor(file = null) {
    this.file = file ?? process.env.IG_ENV_FILE ?? path.resolve(process.cwd(), ".env");
    this.initialized = false;
    this.external = new Set();
    this.managed = new Set();
  }

  /** Re-read the file and sync process.env. Returns a small status object. */
  load() {
    let text = null;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      text = null; // No .env (e.g. Docker env_file): nothing to reload.
    }
    const entries = text === null ? new Map() : parseEnvFile(text);

    if (!this.initialized) {
      for (const [key, value] of entries) {
        if (process.env[key] !== undefined && process.env[key] !== value) {
          this.external.add(key); // explicit CLI/container override
        } else {
          process.env[key] = value;
          this.managed.add(key);
        }
      }
      this.initialized = true;
    } else {
      for (const key of this.managed) {
        if (!entries.has(key) && !this.external.has(key)) delete process.env[key];
      }
      for (const [key, value] of entries) {
        if (!this.external.has(key)) process.env[key] = value;
      }
    }

    this.managed = new Set(entries.keys());
    return {
      file: this.file,
      found: text !== null,
      keys: [...entries.keys()],
      overrides: [...this.external],
    };
  }
}

const config = new Config();

module.exports = { Config, config, parseEnvFile };
