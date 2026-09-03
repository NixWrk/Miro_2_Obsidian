import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: [path.join(rootDir, "src", "main.ts")],
  outfile: path.join(rootDir, "main.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info"
});

if (watch) {
  await context.watch();
  console.log("[miro-canvas] watching for changes");

  const dispose = async () => {
    await context.dispose();
  };
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
} else {
  await context.rebuild();
  await context.dispose();
}
