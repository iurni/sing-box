#!/usr/bin/env node
// Prepare and publish a normal merge of an official stable release. Never force-push.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION_FILE = '.github/baidu-upstream-version';
export const OFFICIAL_REPOSITORY = 'SagerNet/sing-box';
export const OFFICIAL_URL = 'https://github.com/SagerNet/sing-box.git';
export const TARGET_BRANCH = 'codex/baidu';

export function stableParts(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`Not an exact stable release tag: ${tag}`);
  return match.slice(1).map(Number);
}

export function compareTags(left, right) {
  const a = stableParts(left), b = stableParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export function latestStableTag(releases) {
  const stable = releases.flat(Infinity).filter(release =>
    !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name));
  const tags = stable.map(release => release.tag_name).sort(compareTags);
  if (!tags.length) throw new Error('Official GitHub releases contain no stable vX.Y.Z release.');
  return tags.at(-1);
}

function command(program, args, cwd, options = {}) {
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe', env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return null;
    throw new Error(`${program} ${args.join(' ')} failed (${result.status}).\n${result.stderr || ''}${result.stdout || ''}`);
  }
  return (result.stdout || '').trim();
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (/\r|\n/.test(String(value))) throw new Error('Multiline workflow output is forbidden.');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(values));
}

function paths(cwd) {
  const gitDir = command('git', ['rev-parse', '--absolute-git-dir'], cwd);
  return { state: join(gitDir, 'baidu-sync-state.json'), receipt: join(gitDir, 'baidu-validation.json') };
}

function assertClean(cwd) {
  if (command('git', ['status', '--porcelain'], cwd)) throw new Error('Checkout is dirty; commit or stash changes before preparing a sync.');
}

function fetchRelease(cwd, upstream, tag) {
  stableParts(tag);
  command('git', ['fetch', '--no-tags', upstream, `refs/tags/${tag}`], cwd, { inherit: true });
  return command('git', ['rev-parse', 'FETCH_HEAD^{commit}'], cwd);
}

export function prepare({ cwd = process.cwd(), tag, upstream = OFFICIAL_URL, dryRun = false } = {}) {
  cwd = resolve(cwd);
  assertClean(cwd);
  const branch = command('git', ['branch', '--show-current'], cwd);
  if (branch !== TARGET_BRANCH) throw new Error(`Prepare must start on the ${TARGET_BRANCH} branch.`);
  const filePaths = paths(cwd);
  if (existsSync(filePaths.state)) throw new Error('A prepared candidate already exists; inspect it before starting another sync.');
  const previous = readFileSync(join(cwd, VERSION_FILE), 'utf8').trim();
  stableParts(previous);
  if (!tag || upstream === OFFICIAL_URL) {
    const json = command('gh', ['api', '--paginate', '--slurp', `repos/${OFFICIAL_REPOSITORY}/releases?per_page=100`], cwd);
    const releases = JSON.parse(json).flat(Infinity);
    if (tag && !releases.some(release => release.tag_name === tag && !release.draft && !release.prerelease))
      throw new Error('Requested tag is not a published official stable release.');
    tag ||= latestStableTag(releases);
  }
  stableParts(tag);
  if (compareTags(tag, previous) <= 0) {
    output({ changed: false, tag, previous });
    return { changed: false, tag, previous };
  }
  const base = command('git', ['rev-parse', 'HEAD'], cwd);
  const previousCommit = fetchRelease(cwd, upstream, previous);
  if (command('git', ['merge-base', '--is-ancestor', previousCommit, base], cwd, { allowFailure: true }) === null)
    throw new Error('Recorded upstream release is not an ancestor of the custom branch; stop and review the version marker.');
  const releaseCommit = fetchRelease(cwd, upstream, tag);
  // A new stable minor version can be tagged from a different upstream branch.
  // Shared history is enough; a normal merge and the test gates handle divergence.
  if (command('git', ['merge-base', previousCommit, releaseCommit], cwd, { allowFailure: true }) === null)
    throw new Error('New stable tag has no common history with the previous release; upstream history needs manual review.');
  if (dryRun) {
    output({ changed: true, dry_run: true, tag, previous, base, upstream_commit: releaseCommit });
    return { changed: true, tag, previous, base, releaseCommit };
  }
  const candidate = `codex/baidu-sync/${tag}-${randomBytes(6).toString('hex')}`;
  command('git', ['switch', '-c', candidate], cwd, { inherit: true });
  try {
    command('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge official sing-box ${tag}`, releaseCommit], cwd, { inherit: true });
    writeFileSync(join(cwd, VERSION_FILE), `${tag}\n`);
    command('git', ['add', '--', VERSION_FILE], cwd);
    const state = { schema: 1, branch: TARGET_BRANCH, candidate, base, previous, tag,
      releaseCommit, mergeCommit: command('git', ['rev-parse', 'HEAD'], cwd) };
    writeFileSync(filePaths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    rmSync(filePaths.receipt, { force: true });
    output({ changed: true, tag, previous, candidate });
    return state;
  } catch (error) {
    command('git', ['merge', '--abort'], cwd, { allowFailure: true });
    command('git', ['switch', branch], cwd, { inherit: true });
    command('git', ['branch', '-D', candidate], cwd);
    throw error;
  }
}

export function publish({ cwd = process.cwd(), origin = 'origin' } = {}) {
  cwd = resolve(cwd);
  const filePaths = paths(cwd);
  if (!existsSync(filePaths.state) || !existsSync(filePaths.receipt))
    throw new Error('A prepared sync and successful validation receipt are required; no branch was pushed.');
  const state = JSON.parse(readFileSync(filePaths.state, 'utf8'));
  const receipt = JSON.parse(readFileSync(filePaths.receipt, 'utf8'));
  if (state.schema !== 1 || state.branch !== TARGET_BRANCH || receipt.schema !== 1 || receipt.success !== true)
    throw new Error('Invalid sync state or validation receipt.');
  const head = command('git', ['rev-parse', 'HEAD'], cwd);
  const tree = command('git', ['write-tree'], cwd);
  if (command('git', ['branch', '--show-current'], cwd) !== state.candidate || head !== state.mergeCommit ||
      receipt.head !== head || receipt.tree !== tree || receipt.upstreamTag !== state.tag)
    throw new Error('Candidate changed after validation; no branch was pushed.');
  if (command('git', ['diff', '--name-only'], cwd) ||
      command('git', ['diff', '--cached', '--name-only'], cwd) !== VERSION_FILE ||
      command('git', ['ls-files', '--others', '--exclude-standard'], cwd))
    throw new Error('Only the staged upstream version marker may differ from the validated merge.');
  if (receipt.targets?.join(',') !== 'linux/amd64,windows/amd64,android/arm64' ||
      receipt.checks?.join(',') !== 'sync-fixtures,root-go-tests,baidu-race-tests,config-smoke,e2e-loopback')
    throw new Error('Validation did not include every required check and target.');
  const remoteHead = command('git', ['ls-remote', '--exit-code', origin, `refs/heads/${TARGET_BRANCH}`], cwd).split(/\s+/)[0];
  if (remoteHead !== state.base) throw new Error('Remote custom branch advanced while checks ran; stop and rerun from its latest commit.');
  command('git', ['commit', '-m', `Track validated upstream ${state.tag}`], cwd, { inherit: true });
  // Normal fast-forward push remains safe if another push races with the preceding check.
  command('git', ['push', origin, `HEAD:refs/heads/${TARGET_BRANCH}`], cwd, { inherit: true });
  rmSync(filePaths.state);
  rmSync(filePaths.receipt);
  output({ published: true, tag: state.tag, commit: command('git', ['rev-parse', 'HEAD'], cwd) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--publish')) {
      if (args.length !== 1) throw new Error('Publish accepts no extra arguments.');
      publish();
    } else {
      const options = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--dry-run') options.dryRun = true;
        else if (args[i] === '--prepare') continue;
        else if (args[i] === '--tag') options.tag = args[++i];
        else throw new Error(`Unknown argument: ${args[i]}`);
      }
      prepare(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
