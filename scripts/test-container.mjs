import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const docker=(...args)=>execFileSync('docker',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const image='vikunja-mcp:test';
execFileSync('docker',['build','-t',image,'.'],{cwd:root,stdio:'inherit',windowsHide:true});
assert.equal(docker('image','inspect','--format','{{.Config.User}}',image),'node');
let container;
try {
  container=docker('run','-d','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '-p','127.0.0.1::9090','-e','VIKUNJA_TOKEN=container-test-token','-e','VIKUNJA_MCP_API_KEY=container-test-key',image);
  assert.equal(docker('exec',container,'id','-u'),'1000');
  const hostConfig=JSON.parse(docker('inspect',container))[0].HostConfig;
  assert.equal(hostConfig.ReadonlyRootfs,true);assert.deepEqual(hostConfig.CapDrop,['ALL']);
  const binding=docker('port',container,'9090/tcp').split('\n')[0].trim();
  const url=`http://${binding}`;
  let ready=false;
  for(let i=0;i<40;i++) {
    try {const response=await fetch(`${url}/healthz`);if(response.ok) {assert.deepEqual(await response.json(),{ok:true,name:'vikunja-http'});ready=true;break;}} catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready,'Production container did not become live');
  const result=await new Promise((resolve,reject)=>{
    const request=http.request(`${url}/mcp`,{method:'POST',headers:{Host:'127.0.0.1:9090','Content-Type':'application/json',Accept:'application/json, text/event-stream','X-API-Key':'container-test-key'}},response=>{
      let text='';response.on('data',b=>text+=b);response.on('end',()=>{
        try {
          assert.equal(response.statusCode,200);
          const event=text.split('\n').find(line=>line.startsWith('data:'));
          resolve(JSON.parse(event?event.slice(5):text));
        } catch(error) {reject(error);}
      });
    });
    request.setTimeout(5000,()=>request.destroy(new Error('Container MCP request timed out')));
    request.once('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));
  });
  assert.equal(result.result.tools.length,42);
  console.log('Container checks passed: uid 1000, read-only root, dropped capabilities, liveness and 42 MCP tools.');
} finally {
  if(container) {console.log(docker('logs',container));docker('rm','--force',container);}
}
