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

test('uses repository path order when the SCM repository sort key is path', async () => {
  const repoA = createRepository('/workspace/repo-a', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/aaa/repo-c', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
    repositorySortKey: 'path',
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

test('uses discovery order when the SCM repository sort key is discoveryTime', async () => {
  const repoA = createRepository('/workspace/bass-cli', false);
  const repoB = createRepository('/workspace/meta', false);
  const repoC = createRepository('/workspace/build-lab', false);
  const fixture = loadExtensionWithFixture({
    repositories: [repoA, repoB, repoC],
    activeEditorRepository: repoB,
    repositorySortKey: 'discoveryTime',
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
  const activeEditorUri = createUri('/workspace/meta/file.txt');
  const messages = {
    errors: [],
    info: [],
    output: [],
    statusBar: [],
  };
  const executedCommands = [];
  let focusedRepositoryIndex = -1;
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
            assert.equal(key, 'repositories.sortKey');
            return options.repositorySortKey || defaultValue;
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
      async executeCommand(command) {
        executedCommands.push(command);

        if (command === 'list.focusFirst') {
          focusedRepositoryIndex = 0;
          return;
        }

        if (command === 'list.focusDown') {
          focusedRepositoryIndex += 1;
          return;
        }

        if (command === 'list.select') {
          const repositoriesInViewOrder = sortRepositoriesForFixture(
            repositories,
            options.repositorySortKey || 'name'
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

function sortRepositoriesForFixture(repositories, sortKey) {
  if (sortKey === 'path') {
    return [...repositories].sort((a, b) =>
      a.rootUri.fsPath.localeCompare(b.rootUri.fsPath)
    );
  }

  if (sortKey === 'discoveryTime') {
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
