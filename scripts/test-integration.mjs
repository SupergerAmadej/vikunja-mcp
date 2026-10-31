import { createHash } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { mkdir,stat,writeFile,chmod } from 'node:fs/promises';
import { resolve,join } from 'node:path';

const version=process.env.TEST_VIKUNJA_VERSION??'2.7.1';
if(!['2.7.0','2.7.1'].includes(version)) throw new Error('TEST_VIKUNJA_VERSION must be 2.7.0 or 2.7.1');
let binary=process.env.TEST_VIKUNJA_BINARY;
if(!binary) {
  const platform=process.platform;
  if(!['win32','linux'].includes(platform) || process.arch!=='x64') {
    throw new Error(`Set TEST_VIKUNJA_BINARY to the official Vikunja ${version} executable on this platform`);
  }
  const name=platform==='win32'?`vikunja-v${version}-windows-4.0-amd64.exe-full.zip`:`vikunja-v${version}-linux-amd64-full.zip`;
  const release=await fetch(`https://api.github.com/repos/go-vikunja/vikunja/releases/tags/v${version}`);
  if(!release.ok) throw new Error(`Release lookup failed: HTTP ${release.status}`);
  const asset=(await release.json()).assets.find(asset=>asset.name===name);
  if(!asset || !asset.digest?.startsWith('sha256:')) throw new Error('Release asset or SHA256 digest is missing');
  const response=await fetch(asset.browser_download_url);
  if(!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==asset.digest) throw new Error('Release SHA256 digest mismatch');
  const directory=resolve('.tmp/integration-download');await mkdir(directory,{recursive:true});
  const zip=join(directory,'release.zip');await writeFile(zip,bytes);
  if(platform==='win32') {
    const quote=value=>`'${value.replaceAll("'","''")}'`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(directory)} -Force`],{windowsHide:true});
  } else execFileSync('unzip',['-o',zip,'-d',directory],{stdio:'ignore'});
  const executable=platform==='win32'?`vikunja-v${version}-windows-4.0-amd64.exe`:`vikunja-v${version}-linux-amd64`;
  binary=join(directory,executable);
  if(!(await stat(binary)).isFile()) throw new Error('Official release did not contain the expected executable');
  if(platform!=='win32') await chmod(binary,0o755);
}
const result=spawnSync(process.execPath,['--test','test/integration/vikunja.test.mjs'],{
  env:{...process.env,TEST_VIKUNJA_BINARY:resolve(binary)},stdio:'inherit',windowsHide:true,
});
if(result.error) throw result.error;
process.exit(result.status??1);
