// @ts-check
const vscode = require('vscode');
const path = require('node:path');

const noRepositoryStatusBarTimeoutMs = 3000;
const repositoryStatusBarTimeoutMs = 3000;
const repositoryCommandErrorTimeoutMs = 5000;
const repositorySelectionSettleTimeoutMs = 50;
const outputChannelName = 'Reveal Repo';

/** @type {vscode.OutputChannel | undefined} */
let outputChannel;
let runCounter = 0;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  outputChannel = vscode.window.createOutputChannel(outputChannelName);
  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(
      'activeGitRepository.select',
      selectActiveRepository
    )
  );
}

async function selectActiveRepository() {
  const runId = nextRunId();
  const editor = vscode.window.activeTextEditor;

  logRun(runId, 'start');
  logEnvironment(runId);

  if (!editor) {
    logRun(runId, 'noActiveEditor');
    vscode.window.showInformationMessage(
      vscode.l10n.t('No active editor.')
    );
    return;
  }

  /** @type {vscode.Extension<GitExtension> | undefined} */
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  logRun(
    runId,
    `gitExtensionVersion=${gitExtension?.packageJSON?.version || '<unknown>'}`
  );

  if (!gitExtension) {
    logRun(runId, 'gitExtensionMissing');
    vscode.window.showErrorMessage(
      vscode.l10n.t('Built-in Git extension not found.')
    );
    return;
  }

  const extension = await gitExtension.activate();

  if (!extension.enabled) {
    logRun(runId, 'gitExtensionDisabled');
    vscode.window.showErrorMessage(
      vscode.l10n.t('Built-in Git extension is disabled.')
    );
    return;
  }

  const git = extension.getAPI(1);
  const repositories = git.repositories;
  const target = git.getRepository(editor.document.uri);

  logRun(runId, `activeFile=${editor.document.uri.toString()}`);
  logRun(runId, `workspaceFolders=${workspaceFolderNames() || '<none>'}`);
  logRun(runId, `repositoryCount=${repositories.length}`);
  logRun(runId, `repositoriesDiscovered=${repositoryNames(repositories)}`);
  logRun(runId, `target=${target ? repositoryDebugName(target) : '<none>'}`);

  if (!target) {
    logRun(runId, 'result=noRepositoryForActiveFile');
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('No Git repository found for the active file.'),
      noRepositoryStatusBarTimeoutMs
    );
    return;
  }

  const selected = await selectTargetRepository(
    runId,
    repositories,
    target
  );

  if (!selected) {
    logRun(runId, `result=selectionFailed; target=${repositoryDebugName(target)}`);
    vscode.window.setStatusBarMessage(
      vscode.l10n.t(
        'Could not find the VS Code SCM command for repository {0}.',
        repositoryName(target)
      ),
      repositoryCommandErrorTimeoutMs
    );
    return;
  }

  logRun(runId, `result=selected; target=${repositoryDebugName(target)}`);
  vscode.window.setStatusBarMessage(
    vscode.l10n.t('Selected Git repository: {0}', repositoryName(target)),
    repositoryStatusBarTimeoutMs
  );
}

async function focusRepositoriesView() {
  await vscode.commands.executeCommand('workbench.view.scm');
  await vscode.commands.executeCommand('workbench.scm.repositories.focus');
}

/**
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 */
async function selectTargetRepository(runId, repositories, target) {
  await focusRepositoriesView();

  if (target.ui.selected) {
    logRun(runId, 'targetUiSelected=true; no list navigation executed');
    return true;
  }

  const repositoriesInViewOrder = sortRepositoriesForView(runId, repositories);
  const repositoryIndex = repositoriesInViewOrder.findIndex(repository =>
    sameRepository(repository, target)
  );

  logRun(runId, `repositoriesInViewOrder=${repositoryNames(repositoriesInViewOrder)}`);
  logRun(runId, `viewRepositoryIndex=${repositoryIndex}`);

  if (repositoryIndex === -1) {
    return false;
  }

  logRun(runId, 'listNavigation=focusFirst');
  await vscode.commands.executeCommand('list.focusFirst');

  for (let index = 0; index < repositoryIndex; index += 1) {
    await vscode.commands.executeCommand('list.focusDown');
  }

  logRun(runId, `listNavigation=focusDown:${repositoryIndex}`);
  logRun(runId, 'listNavigation=select');
  await vscode.commands.executeCommand('list.select');
  await waitForRepositorySelectionToSettle();
  logSelectedRepositories(runId, repositories, 'selectedRepositoriesAfterListSelect');
  return true;
}

async function waitForRepositorySelectionToSettle() {
  await new Promise(resolve =>
    setTimeout(resolve, repositorySelectionSettleTimeoutMs)
  );
}

/**
 * @param {GitRepository} repository
 */
function repositoryName(repository) {
  return path.basename(repository.rootUri.fsPath);
}

/**
 * @param {GitRepository} repository
 */
function repositoryDebugName(repository) {
  return `${repositoryName(repository)}<${repository.rootUri.fsPath}>`;
}

/**
 * @param {GitRepository[]} repositories
 */
function repositoryNames(repositories) {
  return repositories.map(repositoryDebugName).join(',');
}

function workspaceFolderNames() {
  return (vscode.workspace.workspaceFolders || [])
    .map(folder => `${folder.name}<${folder.uri.fsPath}>`)
    .join(',');
}

/**
 * @param {number} runId
 * @param {GitRepository[]} repositories
 */
function sortRepositoriesForView(runId, repositories) {
  const sortKey = vscode.workspace
    .getConfiguration('scm')
    .get('repositories.sortKey', 'name');

  logRun(runId, `repositorySortKey=${sortKey}`);

  if (sortKey === 'path') {
    return [...repositories].sort(compareRepositoriesByPath);
  }

  if (sortKey === 'discoveryTime') {
    return repositories;
  }

  return [...repositories].sort(compareRepositoriesByName);
}

/**
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {string} label
 */
function logSelectedRepositories(runId, repositories, label) {
  const selectedRepositories = repositories.filter(repository => repository.ui.selected);
  logRun(runId, `${label}=${repositoryNames(selectedRepositories) || '<none>'}`);
}

/**
 * @param {string} message
 */
function logDebug(message) {
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * @param {number} runId
 * @param {string} message
 */
function logRun(runId, message) {
  logDebug(`#${runId} ${message}`);
}

/**
 * @param {number} runId
 */
function logEnvironment(runId) {
  const environment = [
    `vscode:${vscode.version}`,
    `uiKind:${uiKindName(vscode.env.uiKind)}`,
    `remote:${vscode.env.remoteName || '<none>'}`,
  ].join('; ');

  logRun(
    runId,
    `environment=${environment}`
  );
}

function nextRunId() {
  runCounter += 1;
  logDebug(`--- Reveal Repo run #${runCounter} ---`);
  return runCounter;
}

/**
 * @param {vscode.UIKind} uiKind
 */
function uiKindName(uiKind) {
  if (uiKind === vscode.UIKind.Web) {
    return 'web';
  }

  if (uiKind === vscode.UIKind.Desktop) {
    return 'desktop';
  }

  return String(uiKind);
}

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(outputChannelName);
  }

  return outputChannel;
}

/**
 * @param {GitRepository} a
 * @param {GitRepository} b
 */
function sameRepository(a, b) {
  return repositoryKey(a) === repositoryKey(b);
}

/**
 * @param {GitRepository} a
 * @param {GitRepository} b
 */
function compareRepositoriesByName(a, b) {
  return repositoryName(a).localeCompare(repositoryName(b));
}

/**
 * @param {GitRepository} a
 * @param {GitRepository} b
 */
function compareRepositoriesByPath(a, b) {
  return a.rootUri.fsPath.localeCompare(b.rootUri.fsPath);
}

/**
 * @param {GitRepository} repository
 */
function repositoryKey(repository) {
  return repository.rootUri.toString();
}

function deactivate() {
  // Nothing to clean up.
}

module.exports = {
  activate,
  deactivate,
  _test: {
    selectActiveRepository,
  },
};

/**
 * @typedef {object} GitRepository
 * @property {vscode.Uri} rootUri
 * @property {GitRepositoryUI} ui
 *
 * @typedef {object} GitRepositoryUI
 * @property {boolean} selected
 *
 * @typedef {object} GitAPI
 * @property {(uri: vscode.Uri) => GitRepository | null} getRepository
 * @property {GitRepository[]} repositories
 *
 * @typedef {object} GitExtension
 * @property {boolean} enabled
 * @property {(version: 1) => GitAPI} getAPI
 */
