#!/usr/bin/env node
// Prepara o sidecar do agente para o instalador: build + `pnpm deploy` com
// dependências de produção em pastas reais (sem symlinks) dentro dos recursos do Tauri.
// Uso: node scripts/bundle-sidecar.mjs   (chamado por `pnpm build`)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "apps/desktop/src-tauri/resources/agent");
const run = (args) => execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });

run(["--filter", "@ide/agent", "build"]);
rmSync(out, { recursive: true, force: true });
run(["--filter", "@ide/agent", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", out]);

// Só o necessário em runtime.
for (const extra of ["src", "test", "tsconfig.json", "tsconfig.build.json", "node_modules/.bin"]) {
  rmSync(join(out, extra), { recursive: true, force: true });
}

// O SDK traz o CLI nativo como dependência opcional por plataforma; no Linux o pnpm
// instala as variantes glibc e musl (~230 MB cada). Mantém só a da máquina do build.
const scoped = join(out, "node_modules/@anthropic-ai");
if (process.platform === "linux" && existsSync(scoped)) {
  const musl = !process.report?.getReport().header.glibcVersionRuntime;
  for (const name of readdirSync(scoped)) {
    if (/^claude-agent-sdk-linux-/.test(name) && name.endsWith("-musl") !== musl) {
      rmSync(join(scoped, name), { recursive: true, force: true });
      console.log(`bundle-sidecar: removido ${name} (libc diferente)`);
    }
  }
}
console.log(`bundle-sidecar: pronto em ${out}`);
