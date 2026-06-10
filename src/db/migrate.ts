import 'dotenv/config';
import { closeDatabase, runMigrations } from './client.js';
import { log } from '../config/logger.js';

await runMigrations();
await closeDatabase();
log.info('Migration manual finalizada');
