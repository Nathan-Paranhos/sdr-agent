import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const binDir = path.resolve(process.cwd(), 'bin');

async function getLatestGithubRelease(repo, keyword) {
  console.log(`Fetching latest release for ${repo}...`);
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!res.ok) throw new Error(`Failed to fetch release for ${repo}: ${res.statusText}`);
  const json = await res.json();
  const asset = json.assets.find(a => a.name.includes(keyword));
  if (!asset) {
      console.log(`Available assets: ${json.assets.map(a => a.name).join(', ')}`);
      throw new Error(`Asset not found for ${repo} with keyword ${keyword}`);
  }
  return asset.browser_download_url;
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url} to ${dest}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function extractZip(zipFile, outDir) {
  console.log(`Extracting ${zipFile} to ${outDir}...`);
  await execFileAsync('tar', ['-xf', zipFile, '-C', outDir]);
}

async function extractTarGz(tarFile, outDir) {
  console.log(`Extracting ${tarFile} to ${outDir}...`);
  await execFileAsync('tar', ['-xzf', tarFile, '-C', outDir]);
}

async function configureEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = await fs.readFile(envPath, 'utf-8');
  
  const replacements = {
    'NUCLEI_PATH=nuclei': `NUCLEI_PATH=${path.join(binDir, 'nuclei.exe').replace(/\\/g, '/')}`,
    'KATANA_PATH=katana': `KATANA_PATH=${path.join(binDir, 'katana.exe').replace(/\\/g, '/')}`,
    'GOSPIDER_PATH=gospider': `GOSPIDER_PATH=${path.join(binDir, 'gospider.exe').replace(/\\/g, '/')}`,
    'TRUFFLEHOG_PATH=trufflehog': `TRUFFLEHOG_PATH=${path.join(binDir, 'trufflehog.exe').replace(/\\/g, '/')}`,
    'SEC_MOCK_TOOLS=true': 'SEC_MOCK_TOOLS=false'
  };

  for (const [key, val] of Object.entries(replacements)) {
    if (envContent.includes(key)) {
      envContent = envContent.replace(key, val);
    } else {
        // If it doesn't match the exact default from the prompt, try replacing the key using regex
        const regex = new RegExp(`^${key.split('=')[0]}=.*$`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, val);
        } else {
            envContent += `\n${val}`;
        }
    }
  }
  
  await fs.writeFile(envPath, envContent, 'utf-8');
  console.log('.env configured successfully!');
}

async function main() {
  await fs.mkdir(binDir, { recursive: true });

  // 1. Nuclei
  try {
    const nucleiUrl = await getLatestGithubRelease('projectdiscovery/nuclei', 'windows_amd64.zip');
    const nucleiZip = path.join(binDir, 'nuclei.zip');
    await downloadFile(nucleiUrl, nucleiZip);
    await extractZip(nucleiZip, binDir);
  } catch (e) { console.error('Error with Nuclei:', e.message); }

  // 2. Katana
  try {
    const katanaUrl = await getLatestGithubRelease('projectdiscovery/katana', 'windows_amd64.zip');
    const katanaZip = path.join(binDir, 'katana.zip');
    await downloadFile(katanaUrl, katanaZip);
    await extractZip(katanaZip, binDir);
  } catch (e) { console.error('Error with Katana:', e.message); }

  // 3. GoSpider
  try {
    const gospiderUrl = await getLatestGithubRelease('jaeles-project/gospider', 'windows_x86_64'); // sometimes named like this
    const gospiderZip = path.join(binDir, 'gospider.zip');
    await downloadFile(gospiderUrl, gospiderZip);
    await extractZip(gospiderZip, binDir);
  } catch (e) { console.error('Error with GoSpider:', e.message); }

  // 4. TruffleHog
  try {
    const trufflehogUrl = await getLatestGithubRelease('trufflesecurity/trufflehog', 'windows_amd64.tar.gz');
    const trufflehogTar = path.join(binDir, 'trufflehog.tar.gz');
    await downloadFile(trufflehogUrl, trufflehogTar);
    await extractTarGz(trufflehogTar, binDir);
  } catch (e) { console.error('Error with TruffleHog:', e.message); }

  // 5. Wget (Direct download for Windows)
  try {
    const wgetUrl = 'https://eternallybored.org/misc/wget/1.21.4/64/wget.exe';
    const wgetDest = path.join(binDir, 'wget.exe');
    await downloadFile(wgetUrl, wgetDest);
  } catch (e) { console.error('Error with Wget:', e.message); }

  await configureEnv();
  console.log('All tools configured successfully!');
}

main().catch(console.error);
