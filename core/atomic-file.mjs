import { accessSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// 링크 자체를 교체하지 않고 원래 파일의 참조 대상을 갱신한다.
function destination(path, depth = 0) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let entry;
    try { entry = lstatSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry?.isSymbolicLink()) {
      if (depth >= 40) throw Object.assign(new Error('파일 링크가 너무 많습니다.'), { code: 'ELOOP' });
      return destination(resolve(dirname(path), readlinkSync(path)), depth + 1);
    }
    return join(realpathSync(dirname(path)), basename(path));
  }
}

/** 같은 폴더에 완전히 기록한 뒤 교체한다. 실패한 쓰기로 기존 내용을 자르지 않는다. */
export function replaceFile(path, content) {
  const target = destination(resolve(path));
  let previous;
  try { previous = statSync(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!previous.isFile()) throw Object.assign(new Error('규칙 저장 대상이 일반 파일이 아닙니다.'), { code: 'EINVAL' });
    accessSync(target, constants.W_OK);
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, content);
    if (previous) {
      const current = fstatSync(descriptor);
      if (current.uid !== previous.uid || current.gid !== previous.gid) fchownSync(descriptor, previous.uid, previous.gid);
    }
    fchmodSync(descriptor, previous ? previous.mode & 0o777 : 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    created = false;
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
    if (created) {
      try { unlinkSync(temporary); }
      catch (error) { console.error('[approve-here] 임시 규칙 파일을 정리하지 못했습니다:', error); }
    }
  }
}
