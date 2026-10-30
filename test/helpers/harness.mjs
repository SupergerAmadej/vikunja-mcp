import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VIKUNJA_') && !['PORT','HOST'].includes(key)));
}

export async function listen(handler) {
  const server = http.createServer(async (req,res) => {
    try { await handler(req,res); } catch(error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return {
    url:`http://127.0.0.1:${server.address().port}`,
    close:async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); },
  };
}

export async function startMcp(baseUrl, overrides={}) {
  const reservation = await listen((_req,res)=>res.end());
  const port = new URL(reservation.url).port;
  await reservation.close();
  let logs='';
  const processHandle = spawn(process.execPath,['dist/index.js'],{
    cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],
    env:{...cleanEnv(),VIKUNJA_TOKEN:'test-upstream-token',VIKUNJA_MCP_API_KEY:'test-mcp-key',VIKUNJA_BASE_URL:baseUrl,PORT:port,...overrides},
  });
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error(`MCP startup timed out: ${logs}`)),10_000);
    processHandle.once('error',error=>{ clearTimeout(timer); reject(error); });
    processHandle.once('exit',code=>{ clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${logs}`)); });
    processHandle.stderr.on('data',chunk=>{
      logs+=chunk;
      if(logs.includes('listening on')) { clearTimeout(timer); resolve(); }
    });
  });
  let requestId=0;
  const url=`http://127.0.0.1:${port}`;
  return {
    url, logs:()=>logs,
    async rpc(method,params={},options={}) {
      const response=await fetch(`${url}/mcp`,{
        method:options.method??'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','X-API-Key':'test-mcp-key',...options.headers},
        body:options.method==='GET'?undefined:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params}),signal:AbortSignal.timeout(15_000),
      });
      const text=await response.text();
      const event=text.split('\n').find(line=>line.startsWith('data:'));
      return {status:response.status,data:JSON.parse(event?event.slice(5):text),headers:response.headers};
    },
    async close() {
      if(processHandle.exitCode!==null) return;
      const exited=once(processHandle,'exit'); processHandle.kill(); await exited;
    },
  };
}

export async function fixture() {
  const state={
    task:{id:1,title:'Original',description:'Keep description',project_id:1,done:false,priority:1,percent_done:0,due_date:'2027-01-01T00:00:00Z',assignees:[{id:5}],reminders:[{reminder:'2026-12-31T00:00:00Z'}],is_favorite:true},
    project:{id:1,title:'Original project',description:'Keep project',is_archived:false,parent_project_id:0},
    label:{id:1,title:'Original label',description:'Keep label',hex_color:'112233'},atomicSupport:false,
    calls:[],upload:{success:[{id:77,task_id:1,file:{name:'fixture.txt',size:7}}],errors:null},
    beforeWrite:undefined, failWrite:false, reads:0, delay:0, pagination:{},
    taskLabels:[{id:7,title:'Label'}], repeatLabelPage:false, emptyLabelPage:undefined,
  };
  const service=await listen(async (req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString();
    const body=raw && req.headers['content-type']?.includes('application/json')?JSON.parse(raw):raw;
    const url=new URL(req.url,'http://localhost');
    state.calls.push({method:req.method,path:url.pathname,query:url.searchParams,body,headers:req.headers});
    res.setHeader('Content-Type','application/json');
    const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
    if(url.pathname==='/api/v1/info' && req.method==='GET') return send({atomic_field_updates:state.atomicSupport?1:0});
    if(/^\/api\/v2\/(tasks|projects|labels)\/1\/fields$/.test(url.pathname) && req.method==='POST') {
      if(state.failWrite) {const status=typeof state.failWrite==='number'?state.failWrite:503;state.failWrite=false;return send({detail:'Fixture field route failure'},status);}
      if(state.beforeWrite) {const fn=state.beforeWrite;state.beforeWrite=undefined;fn(state);}
      const current=url.pathname.includes('/tasks/')?state.task:url.pathname.includes('/projects/')?state.project:state.label;
      for(const field of body.update_fields) current[field]=body[field];
      return send(current);
    }
    if(url.pathname==='/api/v1/labels/1' && req.method==='GET') return send(state.label);
    if(url.pathname==='/api/v1/labels/1' && req.method==='POST') {state.label={...body};return send(state.label);}
    if(url.pathname==='/api/v1/tasks' && req.method==='GET') {
      const tasks=[{id:4,project_id:1,done:true},{id:5,project_id:2,done:false},{id:6,project_id:2,done:false},{id:7,project_id:2,done:true}];
      const filter=url.searchParams.get('filter')??'';
      const project=/project_id = (\d+)/.exec(filter)?.[1];
      const filtered=tasks.filter(t=>(!project || t.project_id===Number(project)) && (!filter.includes('done = false') || !t.done));
      const page=Number(url.searchParams.get('page')??1),perPage=Number(url.searchParams.get('per_page')??50);
      res.setHeader('X-Pagination-Total-Pages',String(Math.ceil(filtered.length/perPage)));
      const items=filtered.slice((page-1)*perPage,page*perPage);
      res.setHeader('X-Pagination-Result-Count',String(items.length));
      return send(items);
    }
    if(url.pathname==='/api/v1/projects' && req.method==='GET') {
      for(const [header,value] of Object.entries(state.pagination)) res.setHeader(header,value);
      return send([state.project]);
    }
    if(url.pathname==='/api/v1/tasks/1' && req.method==='GET') {
      state.reads++;
      const snapshot=structuredClone({...state.task,labels:[{id:7,title:'Label'}],subtasks:[{id:2,title:'Child'}],time_entries_count:3,comment_count:1,comments:[{id:3,comment:'Hi'}],is_unread:false,buckets:[],reactions:{}});
      await new Promise(resolve=>setTimeout(resolve,state.delay));
      return send(snapshot);
    }
    if(url.pathname==='/api/v1/tasks/1/labels' && req.method==='GET') {
      // Match the upstream bug: SQL uses its configured page size (2 here),
      // while the response headers use the requested per_page value.
      const page=Number(url.searchParams.get('page')??1),perPage=Number(url.searchParams.get('per_page')??2);
      const items=state.emptyLabelPage===page?[]:state.repeatLabelPage?state.taskLabels.slice(0,2):state.taskLabels.slice((page-1)*2,page*2);
      res.setHeader('X-Pagination-Total-Pages',String(Math.ceil(state.taskLabels.length/perPage)));
      res.setHeader('X-Pagination-Result-Count',String(items.length));
      return send(items);
    }
    if(url.pathname==='/api/v1/projects/1' && req.method==='GET') {
      const snapshot=structuredClone(state.project);
      await new Promise(resolve=>setTimeout(resolve,state.delay));
      return send(snapshot);
    }
    if(/^\/api\/v1\/projects\/[^/]+\/tasks\/by-index\/\d+$/.test(url.pathname) && req.method==='GET') return send(state.task);
    if(url.pathname==='/api/v1/projects/1/tasks' && req.method==='PUT') return send({...body,id:2,project_id:1});
    if((url.pathname==='/api/v1/tasks/bulk' || url.pathname==='/api/v1/tasks/1' || url.pathname==='/api/v1/projects/1') && req.method==='POST') {
      if(state.failWrite) {state.failWrite=false;return send({message:'Fixture failure'},503);}
      if(state.beforeWrite) {const fn=state.beforeWrite;state.beforeWrite=undefined;fn(state);}
      if(url.pathname.endsWith('/bulk')) {
        for(const field of body.fields) state.task[field]=body.values[field];
        // v2.7's v1 updater also processes these non-column fields.
        for(const key of ['assignees','reminders','is_favorite']) state.task[key]=body.values[key];
        return send({tasks:[state.task]});
      }
      if(url.pathname.includes('/projects/')) {state.project={...body};return send(state.project);}
      state.task={...body};return send(state.task);
    }
    if(url.pathname==='/api/v1/tasks/1/position') return send({...body,task_id:1,position:body.position+0.5});
    if(url.pathname==='/api/v1/tasks/1/attachments') return send(state.upload);
    if(url.pathname==='/api/v1/tasks/1/assignees/bulk') {state.task.assignees=body.assignees;return send(body);}
    if(url.pathname==='/api/v1/tasks/999') {await new Promise(resolve=>setTimeout(resolve,200));return send({id:999});}
    if(url.pathname==='/api/v1/user') return send({message:'Denied'},403);
    return send({message:`Fixture route not found: ${req.method} ${url.pathname}`},404);
  });
  return {...service,state};
}
