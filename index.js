import { run } from './src/cli.js';
run('analyze', process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
