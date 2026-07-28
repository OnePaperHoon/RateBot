import { createRequire } from 'node:module';

interface PackageJsonShape {
  version?: unknown;
  name?: unknown;
}

function readPackageJson(): PackageJsonShape {
  try {
    // dist/version.js -> ../package.json, src/version.ts -> ../package.json (둘 다 프로젝트 루트)
    const require = createRequire(import.meta.url);
    return require('../package.json') as PackageJsonShape;
  } catch {
    return {};
  }
}

const pkg = readPackageJson();

export const APP_NAME = typeof pkg.name === 'string' ? pkg.name : 'yenwatch';
export const APP_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
