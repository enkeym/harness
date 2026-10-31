import fs from 'node:fs';

Date.now = () => Number(fs.readFileSync(process.env.PROXY_CLOCK, 'utf8'));
