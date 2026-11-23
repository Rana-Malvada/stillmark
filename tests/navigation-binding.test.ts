import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'

it('the real Next adapter preserves signed URLs for HTML, RSC and encoded search navigation', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
 import {AsyncLocalStorage} from 'node:async_hooks';
 globalThis.AsyncLocalStorage=AsyncLocalStorage;
 const config=(await import('./next.config.mjs')).default;
 const {adapter}=await import('next/dist/server/web/adapter.js');
 const {NextResponse}=await import('next/server.js');
 process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE=String(config.skipProxyUrlNormalize ?? false);
 const result=[];
 for(const path of ['/events/335','/events/335?_rsc=abc','/search?q=red%20wine&type=albums&_rsc=xyz']) {
  const {response}=await adapter({page:'/proxy',request:{url:'https://photos.example'+path,method:'GET',headers:{rsc:'1'},nextConfig:config},handler:async req=>NextResponse.json({target:req.nextUrl.pathname+req.nextUrl.search})});
  result.push({sent:path,received:(await response.json()).target});
 }
 console.log(JSON.stringify(result));
 `,
    ],
    { encoding: 'utf8' },
  )
  const rows = JSON.parse(output.trim())
  expect(rows).toHaveLength(3)
  for (const row of rows) expect(row.received).toBe(row.sent)
})
