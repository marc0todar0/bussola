// ============================================================================
// bussola-quotes -- entry point
// ============================================================================
// Starts the service with the configuration in the environment and wires the
// signals: SIGTERM/SIGINT close the server. Everything it keeps (the cache,
// the ISIN listings) is in memory, so there is nothing to write out.
// ============================================================================
const { start } = require("./src/service");

const main = async () => {
  const service = await start();
  console.log(`[service] listening on port ${service.port}`);

  const shutdown = async (signal) => {
    console.log(`[service] ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    await service.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((e) => {
  console.error(`[service] could not start: ${e.message}`);
  process.exit(1);
});
