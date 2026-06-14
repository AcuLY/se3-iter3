import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env, ...readEnvFile(".env"), ...readEnvFile(".env.local") };

const children = [
  start("api", ["run", "dev:api"]),
  start("web", ["run", "dev:web"])
];

function start(name, args) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", ["npm", ...args].join(" ")] : args;
  const child = spawn(command, commandArgs, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  child.stdout.on("data", (chunk) => process.stdout.write(prefix(name, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix(name, chunk)));
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[${name}] exited by ${signal}`);
      return;
    }
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  return child;
}

function readEnvFile(filename) {
  if (!existsSync(filename)) return {};
  const values = {};
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    values[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

function prefix(name, chunk) {
  return chunk
    .toString()
    .split(/\r?\n/)
    .map((line, index, lines) => (line || index < lines.length - 1 ? `[${name}] ${line}` : ""))
    .join("\n");
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
