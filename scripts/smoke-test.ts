/**
* Smoke Test Script
*
* Verifies that the SDK builds correctly and that the compiled output
* can be imported and executed without errors. Focuses on non-network
* helpers to ensure tests are fast and reliable.
*/

// Import from the built output to verify packaging, not the source.
// We use require to verify CommonJS compatibility, which the compiler emits.
const path = require('path');
const fs = require('fs');

const distPath = path.resolve(__dirname, '../dist/index.js');

if (!fs.existsSync(distPath)) {
  console.error('❌ Smoke test failed: dist/index.js not found. Did you run npm run build?');
  process.exit(1);
}

try {
  console.log('📦 Loading compiled SDK...');
  const PocketPay = require(distPath);

  console.log('🧪 Running non-network smoke tests...');

  // 1. Test basic wallet creation
  const wallet = PocketPay.createWallet();
  if (!wallet.publicKey.startsWith('G') || !wallet.secretKey.startsWith('S')) {
    throw new Error('createWallet returned an invalid keypair format');
  }
  console.log('   ✅ createWallet() generated a valid keypair');

  // 2. Test unit conversion helpers
  const stroops = PocketPay.xlmToStroops('10.5');
  if (stroops !== 105000000) {
    throw new Error(`xlmToStroops calculation failed. Expected 105000000, got ${stroops}`);
  }
  console.log('   ✅ xlmToStroops() converted successfully');

  // 3. Test string formatting helper
  const truncated = PocketPay.truncateAddress('GABC1234567890XYZ', 4, 4);
  if (truncated !== 'GABC...0XYZ') {
    throw new Error(`truncateAddress formatting failed. Expected "GABC...0XYZ", got "${truncated}"`);
  }
  console.log('   ✅ truncateAddress() formatted successfully');

  // 4. Test validation logic
  try {
    PocketPay.validateAmount('-10');
    throw new Error('validateAmount should have thrown for a negative amount');
  } catch (error: any) {
    if (error.name !== 'PocketPayError') {
      throw new Error(`validateAmount threw unexpected error type: ${error.name}`);
    }
  }
  console.log('   ✅ validateAmount() rejected invalid input successfully');


  // 5. Resolve the SDK exactly as a package consumer does, through exports["."].
  //    A direct require('../dist/index.js') can pass even when exports is broken.
  const consumer = require('stellar-pocketpay-sdk');
  const manifest = require('stellar-pocketpay-sdk/package.json');
  if (manifest.name !== 'stellar-pocketpay-sdk') {
    throw new Error('package.json export did not resolve the published package');
  }
  const requiredApi = [
    'createWallet', 'safeImportWallet', 'createPaymentIntent',
    'validatePaymentIntent', 'validatePocketPayConfig', 'PocketPayError',
    'ErrorCode', 'ErrorCategory', 'describeError', 'getErrorCategory',
    'classifySubmitError',
  ];
  for (const name of requiredApi) {
    if (!Object.prototype.hasOwnProperty.call(consumer, name)
      || consumer[name] === undefined) {
      throw new Error('Missing package-root export: ' + name);
    }
  }
  if (consumer.createWallet !== PocketPay.createWallet) {
    throw new Error('Package self-reference and dist entrypoint disagree');
  }
  console.log('   ✅ Package-root export map and consumer module imports');

  // 6. Wallet import validation through the package boundary, no key material in logs.
  const imported = consumer.safeImportWallet(wallet.secretKey);
  if (!imported.ok || imported.value.publicKey !== wallet.publicKey) {
    throw new Error('safeImportWallet did not restore the generated public key');
  }
  const rejectedImport = consumer.safeImportWallet('invalid-secret');
  if (rejectedImport.ok || rejectedImport.error?.code !== 'INVALID_SECRET_KEY') {
    throw new Error('safeImportWallet did not reject malformed key material');
  }
  console.log('   ✅ Package-root wallet import: valid and invalid keys');

  // 7. Construct and validate a native payment intent OFFLINE; never submit funds.
  const recipient = consumer.createWallet();
  const intent = consumer.createPaymentIntent({
    source: wallet.publicKey,
    destination: recipient.publicKey,
    amount: '1.0000000',
    asset: { type: 'native', code: 'XLM' },
    memo: 'SDK smoke',
  });
  const intentValidation = consumer.validatePaymentIntent(intent);
  if (intent.status !== 'valid' || !intentValidation.valid
    || intent.source !== wallet.publicKey
    || intent.destination !== recipient.publicKey
    || intent.asset.type !== 'native') {
    throw new Error('Native payment intent failed offline consumer preflight');
  }
  const invalidIntent = consumer.createPaymentIntent({
    source: wallet.publicKey,
    destination: 'invalid-destination',
    amount: '-1',
    asset: { type: 'native', code: 'XLM' },
  });
  if (consumer.validatePaymentIntent(invalidIntent).valid
    || invalidIntent.status === 'valid') {
    throw new Error('Invalid consumer payment intent incorrectly passed preflight');
  }
  console.log('   ✅ Package-root payment intent: valid and invalid preflight');

  // 8. Validate configuration and public error mapping, without an HTTP request.
  const config = consumer.validatePocketPayConfig({
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    timeout: 30000,
  });
  if (!config.valid || config.config?.network !== 'testnet') {
    throw new Error('Public config validator rejected valid Testnet settings');
  }
  const invalidConfig = consumer.validatePocketPayConfig({ network: 'not-a-network' });
  if (invalidConfig.valid || !invalidConfig.errors.some((item: any) => item.code === 'INVALID_NETWORK')) {
    throw new Error('Public config validator accepted an unsupported network');
  }
  const mapped = consumer.classifySubmitError({ response: { status: 429 } });
  if (mapped.code !== consumer.ErrorCode.NET_RATE_LIMITED
    || consumer.getErrorCategory(mapped.code) !== consumer.ErrorCategory.Network
    || !consumer.describeError(mapped.code).known) {
    throw new Error('Public error taxonomy did not classify a throttled submission');
  }
  console.log('   ✅ Package-root config and typed error recovery taxonomy');

  console.log('🎉 Smoke test passed! The SDK imports and runs properly.');
  process.exit(0);

} catch (error) {
  console.error('\n❌ Smoke test failed with an error:');
  console.error(error);
  process.exit(1);
}