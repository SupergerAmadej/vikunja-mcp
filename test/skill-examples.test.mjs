import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir,stat } from 'node:fs/promises';
import { resolve,dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
const root=fileURLToPath(new URL('../',import.meta.url));
const skill=join(root,'skills/vikunja-mcp');
const contract=JSON.parse(await readFile(join(root,'docs/tool-contract.json'),'utf8'));
const schemas=new Map(contract.tools.map(tool=>[tool.name,tool.inputSchema]));
const validator=new AjvJsonSchemaValidator();
const jsonBlocks=text=>[...text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match=>JSON.parse(match[1]));

test('skill examples call exposed tools with schema-valid arguments',async()=>{
  const examples=jsonBlocks(await readFile(join(skill,'references/workflows.md'),'utf8')).flat();
  assert.ok(examples.length>=8,'Validate a useful range of actual tool examples');
  for(const example of examples) {
    const schema=schemas.get(example.tool);assert.ok(schema,`Unknown tool: ${example.tool}`);
    const result=validator.getValidator(schema)(example.arguments);
    assert.ok(result.valid,`${example.tool}: ${result.errorMessage}`);
  }
});

test('skill compatibility note matches the reviewed server contract',async()=>{
  const [compatibility]=jsonBlocks(await readFile(join(skill,'references/tool-contract.md'),'utf8'));
  assert.deepEqual(compatibility,{mcpVersion:contract.server.version,toolCount:contract.tools.length,schemaSha256:contract.schemaSha256});
});

test('the shipped skill is self-contained and has no broken local reference links',async()=>{
  async function walk(directory) {
    const entries=await readdir(directory,{withFileTypes:true});
    return (await Promise.all(entries.map(entry=>entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]))).flat();
  }
  for(const path of await walk(skill)) {
    assert.ok(['.md','.yaml'].some(extension=>path.endsWith(extension)),'The task skill should ship instructions and metadata only');
    if(!path.endsWith('.md')) continue;
    const content=await readFile(path,'utf8');
    for(const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const target=match[1].split('#')[0];if(!target) continue;
      assert.doesNotMatch(target,/^(?:[a-z]+:|[/\\])/i,'Skill references must stay portable and local');
      const destination=resolve(dirname(path),target);
      assert.ok(!relative(skill,destination).startsWith('..'),'Skill reference escapes its folder');
      assert.ok((await stat(destination)).isFile(),`Missing reference: ${target}`);
    }
  }
});
