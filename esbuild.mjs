import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    panel: "src/sidepanel/panel.ts",
    "page-hands": "src/page-hands.ts",
  },
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome120",
  logLevel: "info",
});

await writeFile("dist/sidepanel.html", await readFile("src/sidepanel/index.html"));
await cp("src/sidepanel/panel.css", "dist/panel.css");
await writeFile("dist/manifest.json", await readFile("src/manifest.json"));
