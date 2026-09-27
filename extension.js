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
 * Selects the target repository through the focused repositories list.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 * @returns {Promise<boolean>} Whether the target repository could be selected.
 */
async function selectTargetRepository(runId, repositories, target) {
  await focusRepositoriesView();

  const visibleRepositories = repositoriesVisibleInScmView(runId, repositories, target);
  const repositoryOrders = repositoryOrdersForView(runId, visibleRepositories);

  for (const order of repositoryOrders) {
    if (await selectTargetRepositoryInOrder(runId, repositories, target, order)) {
      return true;
    }
  }

  return false;
}

/**
 * Tries to select the target while assuming one concrete repositories view order.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 * @param {RepositoryOrder} order
 * @returns {Promise<boolean>} Whether this order selected the target.
 */
async function selectTargetRepositoryInOrder(runId, repositories, target, order) {
  const repositoryIndex = order.repositories.findIndex(repository =>
    sameRepository(repository, target)
  );

  logRun(runId, `repositoryOrderAttempt=${order.label}`);
  logRun(runId, `repositoriesInViewOrder=${repositoryNames(order.repositories)}`);
  logRun(runId, `viewRepositoryIndex=${repositoryIndex}`);

  if (repositoryIndex === -1) {
    return false;
  }

  const selectedRepositories = selectedRepositoriesFrom(repositories);
  const selectedRepository = selectedRepositories.length === 1
    ? selectedRepositories[0]
    : undefined;

  if (selectedRepository && sameRepository(selectedRepository, target)) {
    logRun(runId, 'targetUiSelected=true; no list navigation executed');
    return true;
  }

  if (selectedRepositories.length > 1) {
    logRun(runId, `selectedRepositoriesBeforeNavigation=${repositoryNames(selectedRepositories)}`);
  }

  if (selectedRepository) {
    const selectedIndex = order.repositories.findIndex(repository =>
      sameRepository(repository, selectedRepository)
    );

    logRun(
      runId,
      `listNavigation=fromSelectedRepository; selectedIndex:${selectedIndex}; targetIndex:${repositoryIndex}`
    );

    if (selectedIndex !== -1) {
      await moveRepositoryListFocus(runId, repositoryIndex - selectedIndex);

      if (await selectAndVerifyRepository(runId, repositories, target)) {
        return true;
      }
    }
  }

  // The list.* commands are generic workbench commands rather than Git API.
  // Navigating the visible list uses the same ordering the user sees, which has
  // proven more stable than VS Code's private scm<N> repository commands.
  logRun(runId, 'listNavigation=focusFirst');
  await vscode.commands.executeCommand('list.focusFirst');

  await moveRepositoryListFocus(runId, repositoryIndex);

  if (await selectAndVerifyRepository(runId, repositories, target)) {
    return true;
  }

  if (await correctRepositorySelection(
    runId,
    repositories,
    order.repositories,
    target,
    repositoryIndex
  )) {
    return true;
  }

  return false;
}

/**
 * Moves focus in the repositories list by a signed number of rows.
 *
 * @param {number} runId
 * @param {number} offset
 */
async function moveRepositoryListFocus(runId, offset) {
  const command = offset < 0 ? 'list.focusUp' : 'list.focusDown';
  const steps = Math.abs(offset);

  for (let index = 0; index < steps; index += 1) {
    await vscode.commands.executeCommand(command);
  }

  await waitForRepositoryListFocusToSettle();
  logRun(runId, `listNavigation=${command}:${steps}`);
}

/**
 * Gives VS Code a short moment to process queued list focus changes.
 */
async function waitForRepositoryListFocusToSettle() {
  // Repeated list.focusDown commands can resolve before the repositories list
  // has applied the final focused row. Selecting immediately after a long move
  // can therefore select the previous row in large workspaces.
  await new Promise(resolve =>
    setTimeout(resolve, repositorySelectionSettleTimeoutMs)
  );
}

/**
 * Selects the focused repository and verifies whether it is the expected target.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 * @returns {Promise<boolean>}
 */
async function selectAndVerifyRepository(runId, repositories, target) {
  logRun(runId, 'listNavigation=select');
  await vscode.commands.executeCommand('list.select');
  await waitForRepositorySelectionToSettle();
  logSelectedRepositories(runId, repositories, 'selectedRepositoriesAfterListSelect');
  return target.ui.selected;
}

/**
 * Corrects one failed list selection using the repository actually selected.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository[]} repositoriesInViewOrder
 * @param {GitRepository} target
 * @param {number} targetIndex
 * @returns {Promise<boolean>}
 */
async function correctRepositorySelection(
  runId,
  repositories,
  repositoriesInViewOrder,
  target,
  targetIndex
) {
  const selectedRepository = selectedRepositoriesFrom(repositories)[0];
  const selectedIndex = selectedRepository
    ? repositoriesInViewOrder.findIndex(repository =>
      sameRepository(repository, selectedRepository)
    )
    : -1;

  logRun(
    runId,
    `selectionCorrection=selectedIndex:${selectedIndex}; targetIndex:${targetIndex}`
  );

  if (selectedIndex === targetIndex) {
    return false;
  }

  const correctionOffset = selectedIndex === -1
    ? targetIndex + 1
    : targetIndex - selectedIndex;

  // Keep the existing list focus. Re-focusing the repositories view can move
  // focus to a different row than the repository VS Code just selected.
  await moveRepositoryListFocus(runId, correctionOffset);
  return selectAndVerifyRepository(runId, repositories, target);
}

/**
 * Filters Git API repositories down to entries expected in the repositories view.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @param {GitRepository} target
 * @returns {GitRepository[]}
 */
function repositoriesVisibleInScmView(runId, repositories, target) {
  const visibleRepositories = repositories.filter(repository =>
    sameRepository(repository, target) || !hasParentRepository(repository, repositories)
  );
  const hiddenRepositories = repositories.filter(repository =>
    !visibleRepositories.includes(repository)
  );

  if (hiddenRepositories.length > 0) {
    logRun(runId, `repositoriesHiddenAsNested=${repositoryNames(hiddenRepositories)}`);
  }

  return visibleRepositories;
}

/**
 * Checks whether a repository root is nested under another discovered root.
 *
 * @param {GitRepository} repository
 * @param {GitRepository[]} repositories
 * @returns {boolean}
 */
function hasParentRepository(repository, repositories) {
  return repositories.some(candidate =>
    !sameRepository(candidate, repository) &&
    isDescendantPath(repository.rootUri.fsPath, candidate.rootUri.fsPath)
  );
}

/**
 * Returns whether childPath is below parentPath.
 *
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
function isDescendantPath(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath);
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
 * Returns plausible Source Control repository orders, preferred order first.
 *
 * @param {number} runId
 * @param {GitRepository[]} repositories
 * @returns {RepositoryOrder[]}
 */
function repositoryOrdersForView(runId, repositories) {
  // VS Code exposes the configured repository sort order, but the focused SCM
  // view can lag behind or use a user-toggled order. Try the configured order
  // first, then verify and fall back to the other supported orders.
  /** @type {string} */
  const sortOrder = vscode.workspace
    .getConfiguration('scm')
    .get('repositories.sortOrder', 'name');

  logRun(runId, `repositorySortOrder=${sortOrder}`);

  const labels = [sortOrder, 'discovery time', 'name', 'path'];
  /** @type {RepositoryOrder[]} */
  const orders = [];

  for (const label of labels) {
    const repositoriesForOrder = sortRepositoriesForOrder(repositories, label);
    const key = repositoryNames(repositoriesForOrder);

    if (!orders.some(order => repositoryNames(order.repositories) === key)) {
      orders.push({
        label,
        repositories: repositoriesForOrder,
      });
    }
  }

  return orders;
}

/**
 * Sorts repositories using one supported SCM repositories sort order.
 *
 * @param {GitRepository[]} repositories
 * @param {string} sortOrder
 * @returns {GitRepository[]}
 */
function sortRepositoriesForOrder(repositories, sortOrder) {
  if (sortOrder === 'path') {
    return [...repositories].sort(compareRepositoriesByPath);
  }

  if (sortOrder === 'discovery time') {
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
  const selectedRepositories = selectedRepositoriesFrom(repositories);
  logRun(runId, `${label}=${repositoryNames(selectedRepositories) || '<none>'}`);
}

/**
 * Returns repositories currently selected according to the Git API.
 *
 * @param {GitRepository[]} repositories
 * @returns {GitRepository[]}
 */
function selectedRepositoriesFrom(repositories) {
  return repositories.filter(repository => repository.ui.selected);
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
 *
 * @typedef {object} RepositoryOrder
 * @property {string} label
 * @property {GitRepository[]} repositories
 */
