const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;

test.after(() => {
  Module._load = originalLoad;
});

test('shows an information message when no editor is active', async () => {
  const fixture = loadExtensionWithFixture({ activeEditorRepository: undefined });

  await fixture.extension._internal.selectActiveRepository();

  assert.deepEqual(fixture.messages.info, ['No active editor.']);
  assert.deepEqual(fixture.executedCommands, []);
});

test('shows a status bar message when the active file has no Git repository', async () => {
  const repository = createRepository('/workspace/repo-a', true);
  const fixture = loadExtensionWithFixture({
    repositories: [repository],
    activeEditorRepository: null,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.deepEqual(fixture.messages.info, []);
  assert.deepEqual(fixture.messages.statusBar, [
    {
      message: 'No Git repository found for the active file.',
      timeout: 3000,
    },
  ]);
  assert.deepEqual(fixture.executedCommands, []);
});

test('selects the target repository by navigating the repositories list by name', async () => {
  const repoA = createRepository('/workspace/repo-a', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/repo-c', false);

  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(repoA.ui.selected, false);
  assert.equal(repoB.ui.selected, true);
  assert.equal(repoC.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.select',
  ]);
  assert.deepEqual(fixture.messages.statusBar, [
    {
      message: 'Selected Git repository: meta',
      timeout: 3000,
    },
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /selectedRepositoriesAfterListSelect=.*meta/
  );
});

test('moves down to the target repository in sorted repository name order', async () => {
  const repoA = createRepository('/workspace/bass-cli', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/build-lab', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoriesInViewOrder=.*bass-cli.*build-lab.*meta/
  );
});

test('uses repository path order when the SCM repository sort order is path', async () => {
  const repoA = createRepository('/workspace/repo-a', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/aaa/repo-c', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
    repositorySortOrder: 'path',
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(repoA.ui.selected, false);
  assert.equal(repoB.ui.selected, true);
  assert.equal(repoC.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.select',
  ]);
});

test('ignores nested repositories that are not shown in the repositories view', async () => {
  const docker = createRepository('/workspace/docker', false);
  const nestedDocker = createRepository(
    '/workspace/docker/.gitlab-ci-local/builds/.docker',
    false
  );
  const privateRepo = createRepository('/workspace/private_repo', false);
  const puppetClient = createRepository('/workspace/puppet_client', false);
  const fixture = loadExtensionWithFixture({
    repositories: [docker, nestedDocker, privateRepo, puppetClient],
    activeEditorRepository: privateRepo,
    repositorySortOrder: 'path',
    visibleRepositories: [docker, privateRepo, puppetClient],
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(docker.ui.selected, false);
  assert.equal(nestedDocker.ui.selected, false);
  assert.equal(privateRepo.ui.selected, true);
  assert.equal(puppetClient.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoriesHiddenAsNested=.*\.docker/
  );
});

test('corrects selection when list focus starts before the first repository row', async () => {
  const repoA = createRepository('/workspace/bass-cli', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/build-lab', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
    focusFirstRepositoryIndex: -1,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(repoA.ui.selected, false);
  assert.equal(repoB.ui.selected, true);
  assert.equal(repoC.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.focusDown',
    'list.select',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /selectionCorrection=selectedIndex:1; targetIndex:2/
  );
});

test('corrects selection when the first select does not hit a repository row', async () => {
  const repoA = createRepository('/workspace/private_repo', false);
  const repoB = createRepository('/workspace/puppet_client', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB],
    activeEditorRepository: repoA,
    focusFirstRepositoryIndex: -1,
    repositorySortOrder: 'path',
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(repoA.ui.selected, true);
  assert.equal(repoB.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.select',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /selectionCorrection=selectedIndex:-1; targetIndex:0/
  );
});

test('uses discovery order when the SCM repository sort order is discovery time', async () => {
  const repoA = createRepository('/workspace/bass-cli', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/build-lab', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
    repositorySortOrder: 'discovery time',
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(repoA.ui.selected, false);
  assert.equal(repoB.ui.selected, true);
  assert.equal(repoC.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoriesDiscovered=.*bass-cli.*meta.*build-lab/
  );
});

test('corrects when the visible repositories list uses a different sort order', async () => {
  const privateRepo = createRepository('/workspace/private_repo', false);
  const puppetClient = createRepository('/workspace/puppet_client', false);
  const pihole = createRepository('/workspace/pihole', false);
  const fixture = loadExtensionWithFixture({
    repositories: [privateRepo, puppetClient, pihole],
    activeEditorRepository: privateRepo,
    repositorySortOrder: 'path',
    actualViewSortOrder: 'discovery time',
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(privateRepo.ui.selected, true);
  assert.equal(puppetClient.ui.selected, false);
  assert.equal(pihole.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.focusDown',
    'list.select',
    'list.focusUp',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoryOrderAttempt=path/
  );
});

test('tries another repository order when correction cannot recover', async () => {
  const privateRepo = createRepository('/workspace/private_repo', false);
  const puppetClient = createRepository('/workspace/puppet_client', false);
  const pihole = createRepository('/workspace/pihole', false);
  const fixture = loadExtensionWithFixture({
    repositories: [privateRepo, puppetClient, pihole],
    activeEditorRepository: pihole,
    repositorySortOrder: 'path',
    actualViewSortOrder: 'discovery time',
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(privateRepo.ui.selected, false);
  assert.equal(puppetClient.ui.selected, false);
  assert.equal(pihole.ui.selected, true);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusFirst',
    'list.select',
    'list.focusUp',
    'list.select',
    'list.focusFirst',
    'list.focusDown',
    'list.focusDown',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoryOrderAttempt=path/
  );
  assert.match(
    fixture.messages.output.join('\n'),
    /repositoryOrderAttempt=discovery time/
  );
});

test('navigates relative to the currently selected repository when there is one', async () => {
  const argoCd = createRepository('/workspace/platform/delivery/argo-cd', false);
  const arn = createRepository('/workspace/platform/delivery/arn', false);
  const gitops = createRepository('/workspace/platform/delivery/gitops', false);
  const pypromote = createRepository('/workspace/platform/delivery/pypromote', true);
  const fixture = loadExtensionWithFixture({
    repositories: [argoCd, arn, gitops, pypromote],
    activeEditorRepository: argoCd,
    repositorySortOrder: 'path',
    initialFocusedRepositoryIndex: 3,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.equal(argoCd.ui.selected, true);
  assert.equal(arn.ui.selected, false);
  assert.equal(gitops.ui.selected, false);
  assert.equal(pypromote.ui.selected, false);
  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
    'list.focusUp',
    'list.focusUp',
    'list.focusUp',
    'list.select',
  ]);
  assert.match(
    fixture.messages.output.join('\n'),
    /listNavigation=fromSelectedRepository; selectedIndex:3; targetIndex:0/
  );
});

test('does not toggle the target repository when it is already selected', async () => {
  const target = createRepository('/workspace/meta', true);
  const fixture = loadExtensionWithFixture({
    repositories: [target],
    activeEditorRepository: target,
  });

  await fixture.extension._internal.selectActiveRepository();

  assert.deepEqual(fixture.executedCommands, [
    'workbench.view.scm',
    'workbench.scm.repositories.focus',
  ]);
});

function loadExtensionWithFixture(options) {
  const repositories = options.repositories || [];
  const visibleRepositories = options.visibleRepositories || repositories;
  const activeEditorUri = createUri('/workspace/meta/file.txt');
  const messages = {
    errors: [],
    info: [],
    output: [],
    statusBar: [],
  };
  const executedCommands = [];
  let focusedRepositoryIndex = options.initialFocusedRepositoryIndex ?? -1;
  const gitApi = {
    repositories,
    getRepository(uri) {
      assert.equal(uri, activeEditorUri);
      return options.activeEditorRepository;
    },
  };

  const vscodeMock = {
    version: '1.99.0',
    UIKind: {
      Desktop: 1,
      Web: 2,
    },
    env: {
      remoteName: undefined,
      uiKind: 1,
    },
    l10n: {
      t(message, ...args) {
        return message.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
      },
    },
    window: {
      activeTextEditor:
        options.activeEditorRepository === undefined
          ? undefined
          : { document: { uri: activeEditorUri } },
      showErrorMessage(message) {
        messages.errors.push(message);
      },
      showInformationMessage(message) {
        messages.info.push(message);
      },
      createOutputChannel() {
        return {
          appendLine(message) {
            messages.output.push(message);
          },
          dispose() {},
        };
      },
      setStatusBarMessage(message, timeout) {
        messages.statusBar.push({ message, timeout });
      },
    },
    workspace: {
      workspaceFolders: options.workspaceFolders || [],
      getConfiguration(section) {
        assert.equal(section, 'scm');
        return {
          get(key, defaultValue) {
            assert.equal(key, 'repositories.sortOrder');
            return options.repositorySortOrder || defaultValue;
          },
        };
      },
    },
    extensions: {
      getExtension(id) {
        assert.equal(id, 'vscode.git');
        return {
          async activate() {
            return {
              enabled: true,
              getAPI(version) {
                assert.equal(version, 1);
                return gitApi;
              },
            };
          },
        };
      },
    },
    commands: {
      async executeCommand(command, args) {
        executedCommands.push(args === undefined ? command : [command, args]);

        if (command === 'list.focusFirst') {
          focusedRepositoryIndex = options.focusFirstRepositoryIndex || 0;
          return;
        }

        if (command === 'list.focusUp') {
          focusedRepositoryIndex -= 1;
          return;
        }

        if (command === 'list.focusDown') {
          focusedRepositoryIndex += 1;
          return;
        }

        if (command === 'list.select') {
          const repositoriesInViewOrder = sortRepositoriesForFixture(
            visibleRepositories,
            options.actualViewSortOrder || options.repositorySortOrder || 'name'
          );
          const repository = repositoriesInViewOrder[focusedRepositoryIndex];

          for (const currentRepository of repositories) {
            currentRepository.ui.selected = currentRepository === repository;
            currentRepository.ui.fire();
          }
        }
      },
    },
  };

  Module._load = (request, parent, isMain) => {
    if (request === 'vscode') {
      return vscodeMock;
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../extension')];
  const extension = require('../extension');

  return {
    executedCommands,
    extension,
    messages,
  };
}

function sortRepositoriesForFixture(repositories, sortOrder) {
  if (sortOrder === 'path') {
    return [...repositories].sort((a, b) =>
      a.rootUri.fsPath.localeCompare(b.rootUri.fsPath)
    );
  }

  if (sortOrder === 'discovery time') {
    return repositories;
  }

  return [...repositories].sort((a, b) =>
    pathBasename(a.rootUri.fsPath).localeCompare(pathBasename(b.rootUri.fsPath))
  );
}

function pathBasename(filePath) {
  const parts = filePath.split('/');
  return parts[parts.length - 1];
}

function createRepository(path, selected) {
  const listeners = new Set();

  return {
    rootUri: createUri(path),
    ui: {
      selected,
      onDidChange(listener) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
      fire() {
        for (const listener of [...listeners]) {
          listener();
        }
      },
    },
  };
}

function createUri(path) {
  return {
    fsPath: path,
    toString() {
      return `file://${path}`;
    },
  };
}
