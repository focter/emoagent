import { build } from 'vite';

process.env.PORT = process.env.PORT || '4174';
process.env.DOTENV_CONFIG_PATH = process.env.DOTENV_CONFIG_PATH || '.env.example';
process.env.OPENAI_API_KEY = '';
process.env.LLM_API_KEY = '';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.ENABLE_SAFE_LOG = 'false';

await build({ logLevel: 'warn' });

const { startServer } = await import('../server/index.js');
const server = startServer(Number(process.env.PORT));

function shutdown() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
