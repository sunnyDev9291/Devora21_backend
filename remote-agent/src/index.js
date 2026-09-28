const { loadConfig } = require("./config");
const { runLoop } = require("./runner");

async function main() {
  const once = process.argv.includes("--once");
  const config = loadConfig();
  await runLoop(config, { once });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
