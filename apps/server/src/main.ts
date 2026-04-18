import { app, shutdown, start } from "./server.js";

// Global error handlers — prevent silent crashes from background tasks
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", async (err) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  app.log.error({ err }, "Uncaught exception — shutting down");
  await shutdown(1);
});

start().catch(async (error) => {
  app.log.error(error);
  await shutdown(1);
});

process.on("SIGINT", async () => {
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  await shutdown(0);
});
