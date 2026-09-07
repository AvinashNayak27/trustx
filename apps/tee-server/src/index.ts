import 'dotenv/config';
import { createServer } from 'node:http';
import { createReplayApp } from './replayApp.js';
import { PaymentSigner } from './paymentSigner.js';

const appPortValue = process.env.APP_PORT ?? '3000';
if (!/^\d+$/u.test(appPortValue)) throw new Error('APP_PORT must be a valid TCP port');
const appPort = Number(appPortValue);
if (appPort < 1 || appPort > 65_535) throw new Error('APP_PORT must be between 1 and 65535');

const { app: replayApp } = createReplayApp({
  paymentSigner: PaymentSigner.fromEnvironment(),
  logger: (message) => console.log(`[tee] ${message}`),
});
const teeServer = createServer(replayApp).listen(appPort, '0.0.0.0');

console.log(`TEE replay server listening on 0.0.0.0:${appPort}`);

function shutdown() {
  teeServer.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
