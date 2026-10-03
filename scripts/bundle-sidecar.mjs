#!/usr/bin/env node
// Prepara o que vai junto no instalador: o sidecar do agente (build + `pnpm deploy` com
// dependências de produção em pastas reais, sem symlinks, nos recursos do Tauri) e o
// servidor MCP `ide-mcp` (externalBin).
// Uso: node scripts/bundle-sidecar.mjs   (chamado por `pnpm build`)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

// Servidor MCP (crates/mcp): vai como externalBin, instalado ao lado do executável do app,
// onde ide_agent::locate_mcp o procura. O Tauri exige o sufixo com o target triple.
// O Tauri informa o alvo do build (`--target`); sem ele, é o da máquina.
const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"]).toString())?.[1];
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!triple) throw new Error("bundle-sidecar: não foi possível descobrir o target triple (rustc -vV)");
const cross = triple !== host;
execFileSync("cargo", ["build", "--release", "-p", "ide-mcp", ...(cross ? ["--target", triple] : [])], {
  cwd: root,
  stdio: "inherit",
});
const exe = process.platform === "win32" ? ".exe" : "";
const binDir = join(root, "apps/desktop/src-tauri/binaries");
mkdirSync(binDir, { recursive: true });
copyFileSync(join(root, `target/${cross ? `${triple}/` : ""}release/ide-mcp${exe}`), join(binDir, `ide-mcp-${triple}${exe}`));
console.log(`bundle-sidecar: ide-mcp-${triple}${exe} pronto`);
