import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureHome } from './config.mjs';

const run = promisify(execFile);
const REPO = 'SungHoonKim-Ski/approve-here';
const ASSET = 'ApproveHere.app.zip';
const LOCAL_BUILD = new URL('../surfaces/macos/dist/ApproveHere.app', import.meta.url).pathname;

/**
 * 메뉴바 앱을 찾아 연다. 소스 checkout에서 빌드한 것이 있으면 그것, 없으면 데이터 폴더의 사본,
 * 그것도 없으면 GitHub Release에서 내려받는다. 서명이 없는 앱이라 격리 해제는 사용자에게 묻고서만 한다.
 */
export async function launchMenubarApp({ home, log = () => {}, confirm = async () => false, fetchImpl = fetch } = {}) {
  const bundle = existsSync(LOCAL_BUILD) ? LOCAL_BUILD : join(ensureHome(home), 'ApproveHere.app');
  if (!existsSync(bundle)) {
    log(`메뉴바 앱을 내려받습니다: https://github.com/${REPO}/releases/latest/download/${ASSET}`);
    await download(bundle, fetchImpl);
    log(`저장: ${bundle}`);
    const quarantined = await hasQuarantine(bundle);
    if (quarantined) {
      log('이 앱은 Apple 서명·공증이 없습니다. 그대로 열면 macOS가 막고, 시스템 설정 → 개인정보 보호 및 보안에서 "그래도 열기"를 눌러야 합니다.');
      const strip = await confirm('내려받은 앱의 격리 속성을 지금 지워서 바로 열까요? (소스: 위 GitHub Release)');
      if (strip) await run('xattr', ['-dr', 'com.apple.quarantine', bundle]);
      else log('격리 속성을 유지합니다. 처음 한 번은 시스템 설정에서 허용해 주세요.');
    }
  }
  spawn('open', [bundle], { stdio: 'ignore', detached: true }).unref();
  log('메뉴바에 ⏳ 아이콘이 뜹니다. 처음 실행이면 알림 권한을 물을 수 있습니다.');
  return bundle;
}

async function download(bundle, fetchImpl) {
  const dir = join(bundle, '..');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, ASSET);
  const res = await fetchImpl(`https://github.com/${REPO}/releases/latest/download/${ASSET}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`내려받기 실패: HTTP ${res.status}. 직접 받으려면 https://github.com/${REPO}/releases`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  rmSync(bundle, { recursive: true, force: true });
  // ditto는 macOS 번들의 리소스 포크·권한을 보존한다.
  await run('ditto', ['-x', '-k', zip, dir]);
  rmSync(zip, { force: true });
  if (!existsSync(bundle)) throw new Error(`압축을 풀었지만 ${bundle}이 없습니다. zip 안의 폴더 이름을 확인하세요.`);
}

async function hasQuarantine(path) {
  try {
    const { stdout } = await run('xattr', ['-p', 'com.apple.quarantine', path]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}
