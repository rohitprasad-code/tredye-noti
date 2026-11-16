'use strict';

const { TredyeFlowService } = require('./service/flow-service');
const {
  buildOrderBlockRealData,
  compareOrderBlockCandidates,
  computeSetupScore,
} = require('./engine/orderblock-ranking');

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const service = new TredyeFlowService({
    demo: args.has('--demo'),
    dryRun: args.has('--dry-run'),
  });
  service.start().catch(err => {
    console.error('Fatal error starting Tredye Flow Alerts:', err);
    process.exit(1);
  });
}

module.exports = {
  TredyeFlowService,
  buildOrderBlockRealData,
  compareOrderBlockCandidates,
  computeSetupScore,
};
