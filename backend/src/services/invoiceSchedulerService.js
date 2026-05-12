/**
 * invoiceSchedulerService — cron worker for invoice automation.
 *
 * Two jobs:
 *   1. Flush invoices whose `scheduled_send_at` has passed and status
 *      is still 'scheduled' — flips them to 'sent' and queues the email.
 *   2. Run the overdue reminder ladder (first reminder at due_date +
 *      reminder_first_days, second at +second_days w/ late fee).
 *
 * Both jobs are delegated to invoiceService.runScheduledTasks().
 *
 * Wired in server.js boot path next to expirationChecker — see that
 * module for the cron pattern. Runs hourly; the per-row guards inside
 * invoiceService prevent duplicate sends.
 */

const cron = require('node-cron');
const invoiceService = require('./invoiceService');
const { logger } = require('../utils/logger');

let task = null;

function startInvoiceScheduler() {
  if (task) {
    logger.info('Invoice scheduler already running');
    return task;
  }
  // Hourly at minute 11 to spread load away from other hourly jobs.
  task = cron.schedule('11 * * * *', async () => {
    logger.info('Invoice scheduler: tick');
    try {
      await invoiceService.runScheduledTasks();
    } catch (err) {
      logger.error('Invoice scheduler tick failed', { err: err.message });
    }
  });
  logger.info('Invoice scheduler started (hourly @ :11)');
  // Run once on boot so a missed window (server restart) gets caught
  // up immediately.
  invoiceService.runScheduledTasks().catch((err) => {
    logger.warn('Invoice scheduler initial tick failed', { err: err.message });
  });
  return task;
}

function stopInvoiceScheduler() {
  if (task) {
    task.stop();
    task = null;
    logger.info('Invoice scheduler stopped');
  }
}

module.exports = { startInvoiceScheduler, stopInvoiceScheduler };
