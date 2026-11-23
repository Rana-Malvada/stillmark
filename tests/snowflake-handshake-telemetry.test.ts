import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Observe login -> first query transport allocation only, not SQL result decoding.
// Fresh child processes isolate SDK globals; the fixture uses synthetic tokens on loopback.
const fixture = String.raw`
const http = require('node:http');
const sf = require('snowflake-sdk');
sf.configure({ logLevel: 'OFF' });
let connections = 0, telemetry = 0;
const server = http.createServer((req, res) => {
  req.resume();
  const reply = data => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({success:true, data}));
  };
  if (req.url.startsWith('/session/v1/login-request')) return reply({
    token:'synthetic', masterToken:'synthetic', sessionId:1,
    validityInSeconds:3600, masterValidityInSeconds:3600, parameters:[],
    sessionInfo:{databaseName:'TEST',schemaName:'PUBLIC',roleName:'PUBLIC',warehouseName:null}
  });
  if (req.url.startsWith('/telemetry/send')) { telemetry++; return reply({}); }
  if (req.url.startsWith('/queries/v1/query-request')) {
    // Stop at receipt: this test does not emulate the full Snowflake result protocol.
    process.stdout.write(JSON.stringify({connections,telemetry}), () => {
      server.closeAllConnections(); server.close(); process.exit(0);
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.on('connection', () => connections++);
server.listen(0, '127.0.0.1', () => {
  const c = sf.createConnection({account:'synthetic',authenticator:'OAUTH',token:'synthetic',
    accessUrl:'http://127.0.0.1:'+server.address().port,timeout:1000,sfRetryMaxLoginRetries:0});
  c.connect(error => {
    if(error) process.exit(2);
    c.execute({sqlText:'SELECT TRUE',complete:()=>{}});
  });
});
setTimeout(() => process.exit(3), 3000).unref();
`

it('avoids the telemetry request and extra first-query socket with the SDK opt-out', async () => {
  const env = { ...process.env }
  delete env.SF_TELEMETRY_DISABLE_CONNECTION_SHAPE
  const run = async (disabled: boolean) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', fixture], {
      env: disabled ? { ...env, SF_TELEMETRY_DISABLE_CONNECTION_SHAPE: 'true' } : env,
      timeout: 5000,
    })
    return JSON.parse(stdout)
  }
  expect(await run(false)).toEqual({ connections: 2, telemetry: 1 })
  expect(await run(true)).toEqual({ connections: 1, telemetry: 0 })
}, 12_000)
