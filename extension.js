// @ts-check
const vscode = require('vscode');
const path = require('node:path');

const noRepositoryStatusBarTimeoutMs = 3000;
const repositoryStatusBarTimeoutMs = 3000;
const repositorySelectionErrorTimeoutMs = 5000;
const repositorySelectionSettleTimeoutMs = 50;
const outputChannelName = 'Reveal Repo';

/** @type {vscode.OutputChannel | undefined} */
let outputChannel;
let runCounter = 0;

/**
 * Registers the command and creates the diagnostic output channel.
 *
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

/**
 * Selects the Git repository that owns the active editor file.
 */
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
        'Could not select Git repository {0} in the Source Control view.',
        repositoryName(target)
      ),
      repositorySelectionErrorTimeoutMs
    );
    return;
  }

  logRun(runId, `result=selected; target=${repositoryDebugName(target)}`);
  vscode.window.setStatusBarMessage(
    vscode.l10n.t('Selected Git repository: {0}', repositoryName(target)),
    repositoryStatusBarTimeoutMs
  );
}

/**
 * Opens Source Control and focuses its repositories list.
 */
async function focusRepositoriesView() {
  // These command IDs are VS Code workbench commands, not part of the Git
  // extension API. They are much less volatile than the private scm<N> commands
  // we tried earlier, but a VS Code update could still change their behavior.
  // The generic list commands below act on whichever VS Code list currently has
  // focus, so make the Source Control repositories list the active list first.
  await vscode.commands.executeCommand('workbench.view.scm');
  await vscode.commands.executeCommand('workbench.scm.repositories.focus');
}

/**
 * Selects the target repository by navigating the visible repositories list.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 * @returns {Promise<boolean>} Whether the target repository could be selected.
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

  // The list.* commands are generic workbench commands rather than Git API.
  // Navigating the visible list uses the same ordering the user sees, which has
  // proven more stable than VS Code's private scm<N> repository commands.
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

/**
 * Gives VS Code a short moment to reflect list selection into Git API state.
 */
async function waitForRepositorySelectionToSettle() {
  // VS Code command execution can resolve before SCM selection state is reflected
  // back through the Git API. The short delay makes diagnostic logging less racy.
  await new Promise(resolve =>
    setTimeout(resolve, repositorySelectionSettleTimeoutMs)
  );
}

/**
 * Returns the display name VS Code uses for a repository root.
 *
 * @param {GitRepository} repository
 * @returns {string}
 */
function repositoryName(repository) {
  return path.basename(repository.rootUri.fsPath);
}

/**
 * Formats one repository for diagnostic output.
 *
 * @param {GitRepository} repository
 * @returns {string}
 */
function repositoryDebugName(repository) {
  return `${repositoryName(repository)}<${repository.rootUri.fsPath}>`;
}

/**
 * Formats a repository list for diagnostic output.
 *
 * @param {GitRepository[]} repositories
 * @returns {string}
 */
function repositoryNames(repositories) {
  return repositories.map(repositoryDebugName).join(',');
}

/**
 * Formats workspace folders for diagnostic output.
 *
 * @returns {string}
 */
function workspaceFolderNames() {
  return (vscode.workspace.workspaceFolders || [])
    .map(folder => `${folder.name}<${folder.uri.fsPath}>`)
    .join(',');
}

/**
 * Sorts repositories to match the Source Control repositories view.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @returns {GitRepository[]}
 */
function sortRepositoriesForView(runId, repositories) {
  // The Repositories view can be sorted by setting. Mirror that ordering before
  // calculating how many list.focusDown commands are needed to reach the target.
  /** @type {string} */
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
 * Logs the repositories that the Git API currently reports as selected.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {string} label
 */
function logSelectedRepositories(runId, repositories, label) {
  // This log is diagnostic only; it lets issue reports show whether VS Code's
  // Git API observed the same selection the user saw in the Source Control view.
  const selectedRepositories = repositories.filter(repository => repository.ui.selected);
  logRun(runId, `${label}=${repositoryNames(selectedRepositories) || '<none>'}`);
}

/**
 * Writes one timestamped line to the extension output channel.
 *
 * @param {string} message
 */
function logDebug(message) {
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Writes one timestamped line scoped to a command run.
 *
 * @param {number} runId
 * @param {string} message
 */
function logRun(runId, message) {
  logDebug(`#${runId} ${message}`);
}

/**
 * Logs VS Code environment details useful for issue reports.
 *
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

/**
 * Starts a new diagnostic run and returns its numeric id.
 *
 * @returns {number}
 */
function nextRunId() {
  runCounter += 1;
  logDebug(`--- Reveal Repo run #${runCounter} ---`);
  return runCounter;
}

/**
 * Converts VS Code's UIKind enum into stable diagnostic text.
 *
 * @param {vscode.UIKind} uiKind
 * @returns {string}
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

/**
 * Returns the diagnostic output channel, creating it lazily for tests.
 *
 * @returns {vscode.OutputChannel}
 */
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(outputChannelName);
  }

  return outputChannel;
}

/**
 * Compares repositories by canonical root URI.
 *
 * @param {GitRepository} a
 * @param {GitRepository} b
 * @returns {boolean}
 */
function sameRepository(a, b) {
  return repositoryKey(a) === repositoryKey(b);
}

/**
 * Sort comparison matching VS Code's repository name ordering.
 *
 * @param {GitRepository} a
 * @param {GitRepository} b
 * @returns {number}
 */
function compareRepositoriesByName(a, b) {
  return repositoryName(a).localeCompare(repositoryName(b));
}

/**
 * Sort comparison matching VS Code's repository path ordering.
 *
 * @param {GitRepository} a
 * @param {GitRepository} b
 * @returns {number}
 */
function compareRepositoriesByPath(a, b) {
  return a.rootUri.fsPath.localeCompare(b.rootUri.fsPath);
}

/**
 * Returns the stable identity used to compare Git API repository wrappers.
 *
 * @param {GitRepository} repository
 * @returns {string}
 */
function repositoryKey(repository) {
  return repository.rootUri.toString();
}

/**
 * VS Code deactivate hook; no resources need explicit cleanup.
 */
function deactivate() {
  // Nothing to clean up.
}

module.exports = {
  activate,
  deactivate,
  _internal: {
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
