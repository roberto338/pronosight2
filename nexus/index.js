// ══════════════════════════════════════════════
// nexus/index.js — Nexus module entry point
// Mount in server.js:
//   import { nexusRouter, startNexusWorker, startNexusCron } from './nexus/index.js';
//   app.use('/nexus', nexusRouter);
//   startNexusWorker();
//   startNexusCron();
// ══════════════════════════════════════════════

export { default as nexusRouter }  from './routes.js';
export { startNexusWorker }        from './worker.js';
export { startNexusCron }          from './nexusCron.js';
export { dispatchTask }            from './orchestrator.js';
export { startTelegramHandler }    from './telegramHandler.js';
