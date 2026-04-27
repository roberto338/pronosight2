// ══════════════════════════════════════════════
// nexus/index.js — Nexus v2.0 module entry point
// Mount in server.js:
//   import { nexusRouter, startNexusWorker, startNexusCron, startTelegramHandler } from './nexus/index.js';
//   app.use('/nexus', nexusRouter);
//   startNexusWorker();
//   startNexusCron();
//   startTelegramHandler();
// ══════════════════════════════════════════════

export { default as nexusRouter }  from './routes.js';
export { startNexusWorker, stopNexusWorker } from './worker.js';
export { startNexusCron }          from './nexusCron.js';
export { dispatchTask }            from './orchestrator.js';
export { startTelegramHandler }    from './telegramHandler.js';
export { parseNaturalCommand, jarvisTaskToDispatch } from './jarvis.js';
export { runProactivityEngine }    from './proactivity.js';
export { weeklyReview }            from './selfImprovement.js';
export { generateDailyBriefing, generateWeeklyProjectReport, PROJECTS } from './projects.js';
