'use strict';

/**
 * Migration 315: a project holds the inquiry it started from.
 *
 * "Neue Anfrage" creates the project first and the documents later, so the
 * project needs the data an inquiry carries: occasion (an event_types
 * slug_prefix, the same value events.event_type stores), date range,
 * location, guest count, budget, where the inquiry came from, and notes.
 * Quote, contract and gallery creation read these as defaults; nothing
 * copies them back, so an edit here never changes an issued document.
 *
 * invoices.project_id: an invoice created from a project (a deposit before
 * any gallery exists) has no event to roll up through. Existing invoices
 * keep rolling up through their event or deal, so there is no backfill.
 *
 * projects.flow: which stages the job has. NULL or 'full' (quote, contract,
 * gallery, invoice) is what every existing project shows today; 'no_contract'
 * and 'no_quote' leave stages out. projects.skipped_stages: a comma list of
 * stages the admin skipped on this one project. Both only change how the
 * stage strip reads and which next step is offered.
 *
 * projects.status keeps its free-text column; the new values (`inquiry`,
 * `completed`, `cancelled`) need no schema change, and every existing row
 * stays `active`, which is what it shows today. Additive; safe to re-run.
 */

const PROJECT_COLUMNS = [
  ['event_type', (t) => t.string('event_type', 50).nullable()],
  ['event_date', (t) => t.date('event_date').nullable()],
  ['event_end_date', (t) => t.date('event_end_date').nullable()],
  ['location', (t) => t.string('location', 255).nullable()],
  ['guest_count', (t) => t.integer('guest_count').nullable()],
  ['budget_minor', (t) => t.bigInteger('budget_minor').nullable()],
  ['currency', (t) => t.string('currency', 3).nullable()],
  ['source', (t) => t.string('source', 32).nullable()],
  ['notes', (t) => t.text('notes').nullable()],
  ['flow', (t) => t.string('flow', 24).nullable()],
  ['skipped_stages', (t) => t.string('skipped_stages', 64).nullable()],
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('projects')) {
    for (const [column, add] of PROJECT_COLUMNS) {
      if (!(await knex.schema.hasColumn('projects', column))) {
        await knex.schema.alterTable('projects', (table) => { add(table); });
      }
    }
  }

  if (await knex.schema.hasTable('invoices') && !(await knex.schema.hasColumn('invoices', 'project_id'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.integer('project_id').unsigned().nullable()
        .references('id').inTable('projects').onDelete('SET NULL');
      table.index(['project_id']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('invoices') && await knex.schema.hasColumn('invoices', 'project_id')) {
    // The index first: PostgreSQL would drop it with the column, but SQLite's
    // table rebuild is safer without an index on a column that goes away.
    await knex.schema.alterTable('invoices', (table) => {
      table.dropIndex(['project_id']);
    });
    await knex.schema.alterTable('invoices', (table) => {
      table.dropColumn('project_id');
    });
  }
  if (await knex.schema.hasTable('projects')) {
    for (const [column] of [...PROJECT_COLUMNS].reverse()) {
      if (await knex.schema.hasColumn('projects', column)) {
        await knex.schema.alterTable('projects', (table) => { table.dropColumn(column); });
      }
    }
  }
};
