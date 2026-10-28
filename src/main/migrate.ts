// One-time migrations from the pre-rename "Harbor" persisted names.
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pick the userData dir under `appData`: `Tawny`, renaming a legacy `Harbor` dir into place first when
 * `Tawny` doesn't exist yet. If the rename fails, keep using the legacy dir.
 */
export function resolveUserData(appData: string, log: (msg: string) => void = console.error): string {
  const next = path.join(appData, 'Tawny');
  const legacy = path.join(appData, 'Harbor');
  if (fs.existsSync(next) || !fs.existsSync(legacy)) return next;
  try {
    fs.renameSync(legacy, next);
    return next;
  } catch (e) {
    log(`could not rename ${legacy} -> ${next}, using legacy dir: ${(e as Error).message}`);
    return legacy;
  }
}

/** Rename `harbor.json` to `tawny.json` in `dir` when only the legacy file exists. Returns the config path. */
export function migrateConfig(dir: string, log: (msg: string) => void = console.error): string {
  const next = path.join(dir, 'tawny.json');
  const legacy = path.join(dir, 'harbor.json');
  if (!fs.existsSync(next) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, next);
    } catch (e) {
      log(`could not rename ${legacy} -> ${next}, using legacy file: ${(e as Error).message}`);
      return legacy;
    }
  }
  return next;
}
