// Run before the integration tests: they must not "pass" by skipping everything.
if (!process.env.ASTROLOG_BIN) {
  console.error("test:integration needs ASTROLOG_BIN set to the astrolog executable, for example:\n  ASTROLOG_BIN=/opt/astrolog/astrolog npm run test:integration");
  process.exit(1);
}
