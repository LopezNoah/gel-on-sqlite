import { spawn } from "node:child_process";

const children = new Set();
let shuttingDown = false;

const run = (label, command, args) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      return;
    }

    if (code !== 0) {
      console.error(`[${label}] exited with code ${code ?? "unknown"}`);
    } else if (signal) {
      console.error(`[${label}] stopped with signal ${signal}`);
    }

    shutdown(code ?? 0);
  });

  children.add(child);
  return child;
};

const shutdown = (code = 0) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(code);
  }, 500);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", "npm", ["run", "dev"]);
run("ui", "npm", ["run", "ui:dev"]);
