import { parseAllDocuments } from 'yaml';

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const APPLICATION_IMAGES = new Set([
  'wealthgenie-server',
  'wealthgenie-frontend',
  'wealthgenie-ml-service',
]);
const REQUIRED_PRODUCTION_IMAGES = new Set([
  ...APPLICATION_IMAGES,
  'redis',
]);
const APPROVED_PRODUCTION_IMAGE_REPOSITORIES = new Map([
  ['wealthgenie-server', 'ghcr.io/yashaskn8/wealthgenie-server'],
  ['wealthgenie-frontend', 'ghcr.io/yashaskn8/wealthgenie-frontend'],
  ['wealthgenie-ml-service', 'ghcr.io/yashaskn8/wealthgenie-ml-service'],
  ['redis', 'docker.io/library/redis'],
]);
const PRODUCTION_TEMPLATE_IMAGES = new Map([
  ['wealthgenie-server', 'registry-required.invalid/wealthgenie-server@sha256:WEALTHGENIE_SERVER_IMAGE_DIGEST_REQUIRED'],
  ['wealthgenie-frontend', 'registry-required.invalid/wealthgenie-frontend@sha256:WEALTHGENIE_FRONTEND_IMAGE_DIGEST_REQUIRED'],
  ['wealthgenie-ml-service', 'registry-required.invalid/wealthgenie-ml-service@sha256:WEALTHGENIE_ML_SERVICE_IMAGE_DIGEST_REQUIRED'],
  ['redis', 'registry-required.invalid/redis@sha256:WEALTHGENIE_REDIS_IMAGE_DIGEST_REQUIRED'],
]);

function imageRepository(reference) {
  return reference.split('@', 1)[0];
}

function imageRepositoryName(reference) {
  const withoutDigest = reference.split('@', 1)[0];
  const finalPath = withoutDigest.split('/').at(-1) || '';
  return finalPath.split(':', 1)[0];
}

function isImmutableRegistryReference(reference) {
  const match = /^(?<registry>[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?)(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/.exec(reference);
  if (!match) return false;
  const registry = match.groups.registry;
  const registryHost = registry.split(':', 1)[0];
  const isLoopback = registryHost === 'localhost'
    || registryHost.endsWith('.localhost')
    || registryHost.startsWith('127.')
    || registryHost === '0.0.0.0';
  const isReservedPlaceholder = registryHost === 'invalid' || registryHost.endsWith('.invalid');
  return !isLoopback && !isReservedPlaceholder && (registry.includes('.') || registry.includes(':'));
}

function collectImages(value, images, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, images, seen);
    return;
  }
  if (Object.hasOwn(value, 'image')) images.push(value.image);
  for (const child of Object.values(value)) collectImages(child, images, seen);
}

export function validateProductionImageManifest(source, {
  requireAllProductionImages = true,
  mode = 'release',
} = {}) {
  if (!['release', 'template'].includes(mode)) return { valid: false, errors: ['VALIDATION_MODE_INVALID'] };
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    return { valid: false, errors: ['MANIFEST_INVALID_OR_OVERSIZED'] };
  }

  let documents;
  try {
    documents = parseAllDocuments(source, { uniqueKeys: true, maxAliasCount: 20 });
  } catch {
    return { valid: false, errors: ['MANIFEST_YAML_INVALID'] };
  }
  if (documents.length === 0 || documents.some(document => document.errors.length > 0)) {
    return { valid: false, errors: ['MANIFEST_YAML_INVALID'] };
  }

  const images = [];
  for (const document of documents) {
    if (document.contents) collectImages(document.toJS(), images);
  }
  const errors = [];
  const observed = new Set();
  const observedTemplateImages = new Set();
  for (const reference of images) {
    if (typeof reference !== 'string') {
      errors.push('CONTAINER_IMAGE_INVALID');
      continue;
    }
    if (/^sha256:[a-f0-9]{64}$/i.test(reference)) {
      errors.push('DOCKER_IMAGE_ID_IS_NOT_A_REGISTRY_REFERENCE');
      continue;
    }
    const name = imageRepositoryName(reference);
    if (mode === 'template') {
      const expectedMarker = PRODUCTION_TEMPLATE_IMAGES.get(name);
      if (!expectedMarker) {
        errors.push(`UNEXPECTED_PRODUCTION_TEMPLATE_IMAGE:${name}`);
      } else if (reference !== expectedMarker) {
        errors.push(`PRODUCTION_TEMPLATE_IMAGE_MARKER_INVALID:${name}`);
      } else {
        observedTemplateImages.add(name);
      }
      continue;
    }

    if (name === 'mongo') errors.push('IN_CLUSTER_MONGODB_NOT_ALLOWED_IN_PRODUCTION');
    if (name.startsWith('wealthgenie-')) {
      if (!APPLICATION_IMAGES.has(name)) errors.push('UNKNOWN_WEALTHGENIE_IMAGE');
    }
    if (REQUIRED_PRODUCTION_IMAGES.has(name)) observed.add(name);
    if (!isImmutableRegistryReference(reference)) errors.push(`CONTAINER_IMAGE_MUST_USE_IMMUTABLE_REGISTRY_DIGEST:${name}`);
    const approvedRepository = APPROVED_PRODUCTION_IMAGE_REPOSITORIES.get(name);
    if (approvedRepository && imageRepository(reference) !== approvedRepository) {
      errors.push(`UNAPPROVED_PRODUCTION_IMAGE_REPOSITORY:${name}`);
    }
  }

  if (requireAllProductionImages && mode === 'release') {
    for (const name of REQUIRED_PRODUCTION_IMAGES) {
      if (!observed.has(name)) {
        errors.push(APPLICATION_IMAGES.has(name)
          ? `APPLICATION_IMAGE_MISSING:${name}`
          : `INFRASTRUCTURE_IMAGE_MISSING:${name}`);
      }
    }
  }
  if (mode === 'template') {
    for (const name of PRODUCTION_TEMPLATE_IMAGES.keys()) {
      if (!observedTemplateImages.has(name)) errors.push(`PRODUCTION_TEMPLATE_IMAGE_MISSING:${name}`);
    }
  }
  if (images.length === 0) errors.push('CONTAINER_IMAGES_MISSING');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

async function readStdinBounded() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_MANIFEST_BYTES) throw new Error('Production manifest exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

try {
  const source = await readStdinBounded();
  const templateMode = process.argv.includes('--template');
  if (templateMode && process.argv.includes('--fragment')) throw new Error('Use either --template or --fragment, not both.');
  const result = validateProductionImageManifest(source, {
    requireAllProductionImages: !process.argv.includes('--fragment'),
    mode: templateMode ? 'template' : 'release',
  });
  if (!result.valid) {
    process.stderr.write(`Production image identity validation failed: ${result.errors.join(', ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(source);
  }
} catch (error) {
  process.stderr.write(`Production image identity validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
