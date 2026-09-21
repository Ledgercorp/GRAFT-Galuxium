#!/usr/bin/env node
// Start the GRAFT licensing service. Reads all secrets from the environment (use
// `node --env-file=.env packages/licensing/src/cli.js` for local development) and
// refuses to start if the transacting secrets are absent, so it fails closed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireStripe } from './config.js';
import { stripeClient } from './stripe.js';
import { fileStore } from './store.js';
import { createLicenseRegistry } from './licenses.js';
import { createLicensingServer } from './server.js';
import { createLicenseMailer } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = requireStripe(loadConfig());
const storePath = config.storePath || path.join(here, '../.data/licenses.json');

const stripe = stripeClient({ secretKey: config.secretKey });
const registry = createLicenseRegistry({ store: fileStore(storePath), product: config.product, maxActivations: config.maxActivations });
const mailer = createLicenseMailer({ ...config.mail, downloadUrl: config.downloadUrl });
const { server } = createLicensingServer({ config, stripe, registry, mailer });

server.listen(config.port, () => {
  console.log(`GRAFT licensing (${config.mode} mode, Stripe Managed Payments / Merchant of Record) on :${config.port}`);
  console.log(`Public URL: ${config.publicUrl}  ·  license store: ${storePath}  ·  key email: ${mailer.enabled ? 'enabled' : 'not configured (success page only)'}`);
  if (config.mode === 'live') console.warn('WARNING: live Stripe key in use — real charges will occur.');
});
