import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

const bad = code => Object.assign(new Error(code), { code });
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Hash a local approval without reading it into memory or storing its path. */
export async function digestPrivateApprovalFile(filePath, repositoryRoot) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)
    || typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) {
    throw bad('PRIVATE_APPROVAL_PATH_INVALID');
  }
  let documentPath;
  try {
    const source = await lstat(filePath);
    if (!source.isFile() || source.isSymbolicLink()
      || source.size < 1 || source.size > MAX_DOCUMENT_BYTES) {
      throw bad('PRIVATE_APPROVAL_FILE_INVALID');
    }
    documentPath = await realpath(filePath);
  } catch (error) {
    if (error.code === 'PRIVATE_APPROVAL_FILE_INVALID') throw error;
    throw bad('PRIVATE_APPROVAL_FILE_UNREADABLE');
  }
  const withinRepository = relative(repositoryRoot, documentPath);
  if (withinRepository === '' || (!withinRepository.startsWith('..')
    && !isAbsolute(withinRepository))) throw bad('PRIVATE_APPROVAL_MUST_STAY_OUTSIDE_REPOSITORY');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(documentPath)) {
      bytes += chunk.length;
      if (bytes > MAX_DOCUMENT_BYTES) throw bad('PRIVATE_APPROVAL_FILE_INVALID');
      hash.update(chunk);
    }
  } catch (error) {
    if (error.code === 'PRIVATE_APPROVAL_FILE_INVALID') throw error;
    throw bad('PRIVATE_APPROVAL_FILE_UNREADABLE');
  }
  return hash.digest('hex');
}
