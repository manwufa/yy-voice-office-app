import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { app } from 'electron';

interface IncrementalUpdateFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
  executable?: boolean;
}

interface IncrementalUpdatePackage {
  version: string;
  files: IncrementalUpdateFile[];
}

interface IncrementalUpdateManifest {
  version: string;
  notes?: string;
  packages?: Record<string, IncrementalUpdatePackage>;
}

interface InstallInfo {
  platformKey: string;
  installRoot: string;
  restartTarget: string;
  canUpdate: boolean;
}

export interface IncrementalUpdateCheckResult {
  available: boolean;
  currentVersion: string;
  version: string;
  notes?: string;
  platformKey: string;
  changedFiles: number;
  downloadBytes: number;
  unsupportedReason?: string;
}

interface InternalUpdatePlan extends IncrementalUpdateCheckResult {
  manifestUrl: string;
  files: IncrementalUpdateFile[];
  installRoot: string;
  restartTarget: string;
}

export interface IncrementalUpdateInstallResult {
  started: boolean;
  check: IncrementalUpdateCheckResult;
  scriptPath?: string;
  targetDir?: string;
}

export async function checkForIncrementalUpdate(manifestUrl: string): Promise<IncrementalUpdateCheckResult> {
  const plan = await makeUpdatePlan(manifestUrl);
  return toPublicCheck(plan);
}

export async function installIncrementalUpdate(manifestUrl: string): Promise<IncrementalUpdateInstallResult> {
  const plan = await makeUpdatePlan(manifestUrl);
  const check = toPublicCheck(plan);
  if (!plan.available || plan.files.length === 0) return { started: false, check };
  if (plan.unsupportedReason) return { started: false, check };

  const stageDir = join(app.getPath('userData'), 'pending-update', `${plan.version}-${Date.now()}`);
  const payloadDir = join(stageDir, 'payload');
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(stageDir, 'target-dir.txt'), `${plan.installRoot}\n`, 'utf8');

  for (const file of plan.files) {
    const stageFile = safeResolve(payloadDir, file.path);
    await mkdir(dirname(stageFile), { recursive: true });
    await downloadFile(resolveUpdateUrl(plan.manifestUrl, file.url), stageFile);
    const actualHash = await sha256File(stageFile);
    if (actualHash !== file.sha256) {
      throw new Error(`Downloaded file hash mismatch: ${file.path}`);
    }
    if (file.executable) await chmod(stageFile, 0o755);
  }

  const scriptPath = await writeApplyScript(plan, stageDir, payloadDir);
  launchApplyScript(scriptPath);
  return {
    started: true,
    check,
    scriptPath,
    targetDir: plan.installRoot
  };
}

async function makeUpdatePlan(manifestUrl: string): Promise<InternalUpdatePlan> {
  const manifest = await fetchManifest(manifestUrl);
  const installInfo = getInstallInfo();
  const currentVersion = app.getVersion();
  const basePlan = {
    available: false,
    currentVersion,
    version: manifest.version,
    notes: manifest.notes,
    platformKey: installInfo.platformKey,
    changedFiles: 0,
    downloadBytes: 0,
    manifestUrl,
    files: [],
    installRoot: installInfo.installRoot,
    restartTarget: installInfo.restartTarget
  };

  const updatePackage = manifest.packages?.[installInfo.platformKey];
  if (!updatePackage) {
    return {
      ...basePlan,
      unsupportedReason: `更新源没有 ${installInfo.platformKey} 的增量包。`
    };
  }

  if (!installInfo.canUpdate) {
    return {
      ...basePlan,
      unsupportedReason: '当前不是下载版客户端，无法直接覆盖安装目录。'
    };
  }

  const changedFiles: IncrementalUpdateFile[] = [];
  let downloadBytes = 0;
  for (const file of updatePackage.files) {
    const localFile = safeResolve(installInfo.installRoot, file.path);
    const currentHash = existsSync(localFile) ? await sha256File(localFile) : null;
    if (currentHash !== file.sha256) {
      changedFiles.push(file);
      downloadBytes += file.size;
    }
  }

  return {
    ...basePlan,
    available: changedFiles.length > 0,
    version: updatePackage.version || manifest.version,
    changedFiles: changedFiles.length,
    downloadBytes,
    files: changedFiles
  };
}

async function fetchManifest(manifestUrl: string): Promise<IncrementalUpdateManifest> {
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Update manifest request failed: HTTP ${response.status}`);
  const manifest = (await response.json()) as IncrementalUpdateManifest;
  if (!manifest.version) throw new Error('Update manifest is missing version.');
  return manifest;
}

function getInstallInfo(): InstallInfo {
  const platformKey = `${process.platform}-${process.arch}`;
  const appPath = app.getAppPath();

  if (process.platform === 'win32') {
    const installRoot = dirname(process.execPath);
    return {
      platformKey,
      installRoot,
      restartTarget: process.execPath,
      canUpdate: isInside(appPath, installRoot)
    };
  }

  if (process.platform === 'darwin') {
    const installRoot = findMacAppRoot(process.execPath);
    return {
      platformKey,
      installRoot,
      restartTarget: installRoot,
      canUpdate: isInside(appPath, installRoot)
    };
  }

  return {
    platformKey,
    installRoot: dirname(process.execPath),
    restartTarget: process.execPath,
    canUpdate: false
  };
}

function findMacAppRoot(execPath: string): string {
  const marker = '.app/Contents/MacOS/';
  const normalized = execPath.replace(/\\/g, '/');
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return dirname(dirname(dirname(execPath)));
  return normalized.slice(0, markerIndex + '.app'.length);
}

function safeResolve(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe update path: ${relativePath}`);
  }

  const target = resolve(rootDir, ...normalized.split('/').filter(Boolean));
  if (!isInside(target, rootDir) && target !== resolve(rootDir)) {
    throw new Error(`Update path escapes target folder: ${relativePath}`);
  }
  return target;
}

function isInside(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath).toLowerCase();
  const parent = resolve(parentPath).toLowerCase();
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function sha256File(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, data);
}

function resolveUpdateUrl(manifestUrl: string, fileUrl: string): string {
  return new URL(fileUrl, manifestUrl).toString();
}

async function writeApplyScript(plan: InternalUpdatePlan, stageDir: string, payloadDir: string): Promise<string> {
  const logPath = join(app.getPath('userData'), 'last-update.log');
  if (process.platform === 'win32') {
    const scriptPath = join(stageDir, 'apply-update.cmd');
    await writeFile(
      scriptPath,
      [
        '@echo off',
        'setlocal',
        `set "APP_DIR=${cmdValue(plan.installRoot)}"`,
        `set "STAGE_DIR=${cmdValue(payloadDir)}"`,
        `set "EXE_PATH=${cmdValue(plan.restartTarget)}"`,
        `set "LOG_PATH=${cmdValue(logPath)}"`,
        `echo Target folder: %APP_DIR% > "%LOG_PATH%"`,
        `echo Stage folder: %STAGE_DIR% >> "%LOG_PATH%"`,
        ':wait_for_exit',
        `tasklist /FI "PID eq ${process.pid}" | findstr /R "\\<${process.pid}\\>" >nul`,
        'if not errorlevel 1 (',
        '  timeout /t 1 /nobreak >nul',
        '  goto wait_for_exit',
        ')',
        'robocopy "%STAGE_DIR%" "%APP_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS /NP >> "%LOG_PATH%" 2>&1',
        'set "COPY_RESULT=%ERRORLEVEL%"',
        'if %COPY_RESULT% GEQ 8 exit /b %COPY_RESULT%',
        'start "" "%EXE_PATH%"',
        'exit /b 0',
        ''
      ].join('\r\n'),
      'utf8'
    );
    return scriptPath;
  }

  const scriptPath = join(stageDir, 'apply-update.sh');
  await writeFile(
    scriptPath,
    [
      '#!/bin/sh',
      'set -eu',
      `APP_DIR=${shValue(plan.installRoot)}`,
      `STAGE_DIR=${shValue(payloadDir)}`,
      `LOG_PATH=${shValue(logPath)}`,
      `TARGET_APP=${shValue(plan.restartTarget)}`,
      `echo "Target folder: $APP_DIR" > "$LOG_PATH"`,
      `echo "Stage folder: $STAGE_DIR" >> "$LOG_PATH"`,
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
      'cp -R "$STAGE_DIR"/. "$APP_DIR"/ >> "$LOG_PATH" 2>&1',
      'xattr -dr com.apple.quarantine "$APP_DIR" >/dev/null 2>&1 || true',
      'open "$TARGET_APP"',
      ''
    ].join('\n'),
    'utf8'
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function launchApplyScript(scriptPath: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' })
      : spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

function cmdValue(value: string): string {
  return value.replace(/"/g, '');
}

function shValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toPublicCheck(plan: InternalUpdatePlan): IncrementalUpdateCheckResult {
  return {
    available: plan.available,
    currentVersion: plan.currentVersion,
    version: plan.version,
    notes: plan.notes,
    platformKey: plan.platformKey,
    changedFiles: plan.changedFiles,
    downloadBytes: plan.downloadBytes,
    unsupportedReason: plan.unsupportedReason
  };
}
