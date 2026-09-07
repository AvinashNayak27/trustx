import { createReplayApp } from '../src/replayApp.js';
import { PaymentSigner } from '../src/paymentSigner.js';

const { app } = createReplayApp({
  paymentSigner: PaymentSigner.fromEnvironment(),
  logger: (message) => console.log(`[tee] ${message}`),
});

export default app;
