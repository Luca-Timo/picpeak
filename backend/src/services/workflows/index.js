/**
 * Workflow engine public surface.
 *
 *   const { emitWorkflowEvent } = require('./services/workflows');
 *
 * `engine` holds the executor (start/advance/resume), `registry` the catalog
 * of conditions/actions. Action/condition handler modules require `registry`
 * and call registerAction/registerCondition at load time.
 */
const engine = require('./engine');
const registry = require('./registry');

module.exports = {
  ...engine,
  registry,
};
