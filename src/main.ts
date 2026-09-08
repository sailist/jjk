import * as vscode from "vscode";
import { Effect, ManagedRuntime, Scope } from "effect";
import { resolveRepoPath } from "./jjUtils";
import { parseRenamePaths } from "./parsers";
import { isJjInternalPath } from "./utils";
import { JJDecorationProvider } from "./decorationProvider";
import {
  JJFileSystemProviderNew,
  runFileSystemProviderCleanup,
} from "./fileSystemProviderNew";
import type { RepoHandle } from "./repoHandle";
import { logger } from "./logger";
import { LogOutputChannelTransport } from "./vendor/winston-transport-vscode/logOutputChannelTransport";
import winston from "winston";
import {
  ExtensionResourcesLive,
  resolveExtensionResources,
} from "./services/ExtensionResources";
import {
  Vscode,
  VscodeLive,
  getConfigurationValue,
  setContext,
  updateWorkspaceState,
} from "./services/Vscode";
import { closeScope, scopedDisposable } from "./effectUtils";
import { makeSelectedRepositoryController } from "./selectedRepository";
import { registerGlobalCommands, registerInitCommands } from "./commands";
import { makeRepoLocator } from "./repoLocator";
import {
  createGlobalCommandHandlers,
  createInitCommandHandlers,
} from "./commandHandlers";
import { setupColocatedWarnings } from "./colocatedWarnings";
import { buildWorkspaceSCMCompatLayer } from "./workspaceScmCompat";
import {
  createExtensionEffectRunner,
  retryImmutable,
  runRepoCommand,
  runRepoEffect,
  toError,
  withSourceControlProgress,
} from "./effectRunners";
import { makeRepoLifecycle } from "./repoLifecycle";
import { initializeExtensionViews } from "./extensionViews";
import { JJGraphView, type JJGraphRepoSource } from "./graphPanel/jjGraphView";
import { JJDataSource } from "./graphPanel/dataSource";
import { JJGraphExtensionState } from "./graphPanel/extensionState";
import { AvatarManager } from "./graphPanel/avatarManager";
import { DiffDocProvider } from "./graphPanel/diffDocProvider";
import { ReviewCommentStore } from "./review/commentStore";
import { ReviewManager } from "./review/reviewManager";
import { ReviewFilesView } from "./review/reviewFilesTreeView";
import {
  EmptyReviewDocProvider,
  EMPTY_REVIEW_DOC_SCHEME,
} from "./review/emptyDocProvider";

export async function activate(context: vscode.ExtensionContext) {
  const vscodeLayer = VscodeLive(context);
  const extensionRuntime = ManagedRuntime.make(vscodeLayer);
  const extensionScope = await extensionRuntime.runPromise(Scope.make());
  const runInExtensionScope = <A, E>(
    effect: Effect.Effect<A, E, Vscode | Scope.Scope>,
  ) => extensionRuntime.runPromise(Scope.extend(effect, extensionScope));
  const registerScoped = <A extends { dispose(): unknown }>(acquire: () => A) =>
    runInExtensionScope(scopedDisposable(acquire));
  const { runExtensionEffect, dispatchExtensionEffect } =
    createExtensionEffectRunner(extensionRuntime);

  context.subscriptions.push({
    dispose: () => {
      void extensionRuntime
        .runPromise(closeScope(extensionScope))
        .finally(() => {
          void extensionRuntime.dispose();
        });
    },
  });

  // --- Logging setup ---
  await runInExtensionScope(
    Effect.gen(function* () {
      const outputChannel = yield* scopedDisposable(() =>
        vscode.window.createOutputChannel("Jujutsu Kaizen", {
          log: true,
        }),
      );
      const loggerTransport = new LogOutputChannelTransport({
        outputChannel,
        format: winston.format.simple(),
      });
      yield* Effect.sync(() => logger.add(loggerTransport));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          logger.remove(loggerTransport);
        }),
      );
    }),
  );

  logger.info("Extension activated");

  const customFakeEditorPath = await extensionRuntime.runPromise(
    getConfigurationValue<string | null>("jjk", "fakeEditorPath"),
  );
  const extensionResourcesConfig = resolveExtensionResources(
    context.extensionUri,
    customFakeEditorPath,
  );
  const extensionResourcesLayer = ExtensionResourcesLive(
    extensionResourcesConfig,
  );

  // --- Decoration provider ---
  const decorationProvider = new JJDecorationProvider((dp) => {
    void registerScoped(() => vscode.window.registerFileDecorationProvider(dp));
  });

  // --- File system provider ---
  const repos: RepoHandle[] = [];
  const repoLocator = makeRepoLocator(() => repos);
  let extensionViews:
    | Awaited<ReturnType<typeof initializeExtensionViews>>
    | undefined;
  const fileSystemProvider = await runInExtensionScope(
    Effect.gen(function* () {
      const provider = yield* scopedDisposable(
        () => new JJFileSystemProviderNew(() => repos),
      );
      yield* runFileSystemProviderCleanup(provider);
      yield* scopedDisposable(() =>
        vscode.workspace.registerFileSystemProvider("jj", provider, {
          isReadonly: true,
          isCaseSensitive: true,
        }),
      );
      return provider;
    }),
  );
  const findRepoByUri = repoLocator.findRepoByUri;
  const repoLifecycle = makeRepoLifecycle({
    repos,
    runInExtensionScope,
    extensionRuntime,
    extensionResourcesConfig,
    extensionResourcesLayer,
    decorationProvider,
    fileSystemProvider,
    getGraphWebview: () => extensionViews?.graphWebview,
    getOperationLogManager: () => extensionViews?.operationLogManager,
    getWorkspacesManager: () => extensionViews?.workspacesManager,
    reconcileSelectedRepo: () =>
      extensionRuntime.runPromise(selectedRepoController.reconcileSelection()),
  });
  await repoLifecycle.initializeDiscoveredRepos();
  const { syncReposWithWorkspaceFolders, poll } = repoLifecycle;

  // --- Check for colocated repos ---
  const colocatedWarnings = await setupColocatedWarnings({
    repos: () => repos,
    registerScoped,
    dispatchExtensionEffect,
  });
  const checkReposFunction = (specificFolders?: string[]) =>
    colocatedWarnings.checkRepos(specificFolders);
  await runExtensionEffect(
    colocatedWarnings.checkRepos(),
    "Failed to initialize colocated repository warnings",
  );

  // --- Set repo context and eagerly init views ---
  if (repos.length > 0) {
    void extensionRuntime.runPromise(setContext("jj.reposExist", true));
  } else {
    void extensionRuntime.runPromise(setContext("jj.reposExist", false));
  }

  // --- Selected repo for graph/operation log ---
  const selectedRepoController = await runInExtensionScope(
    makeSelectedRepositoryController({
      repos: () => repos,
      initialSelectedRoot:
        context.workspaceState.get<string>("selectedRepository"),
      persistSelectedRoot: (root) =>
        Effect.tryPromise({
          try: () =>
            extensionRuntime.runPromise(
              updateWorkspaceState("selectedRepository", root),
            ),
          catch: toError,
        }),
    }),
  );
  await runInExtensionScope(selectedRepoController.reconcileSelection());
  const selectedRepo = selectedRepoController;

  // --- JJ Graph panel (editor-area webview) ---
  const graphLogger = {
    log: (message: string) => logger.info(message),
    logError: (message: string) => logger.error(message),
  };
  const graphPanelState = new JJGraphExtensionState(context);
  const graphDataSource = new JJDataSource(
    extensionResourcesConfig.configTomlPath,
    (repo) =>
      repos.find((handle) => handle.config.repositoryRoot === repo)?.config
        .jjPath ?? "jj",
    () => repos[0]?.config.jjPath ?? "jj",
    graphLogger,
  );
  const graphAvatarManager = new AvatarManager(graphPanelState, graphLogger);
  const graphDiffDocProvider = new DiffDocProvider(graphDataSource);
  await registerScoped(() =>
    vscode.workspace.registerTextDocumentContentProvider(
      DiffDocProvider.scheme,
      graphDiffDocProvider,
    ),
  );

  // --- Review panel ---
  const reviewStore = new ReviewCommentStore();
  const reviewManager = new ReviewManager(reviewStore);
  const reviewFilesView = new ReviewFilesView(reviewManager);
  context.subscriptions.push(reviewManager, reviewFilesView);
  await registerScoped(() =>
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_REVIEW_DOC_SCHEME,
      new EmptyReviewDocProvider(),
    ),
  );
  const graphReposChangedEmitter = await registerScoped(
    () => new vscode.EventEmitter<void>(),
  );
  const graphRepoSource: JJGraphRepoSource = {
    getRepos: () => repos.map((repo) => repo.config.repositoryRoot),
    getSelectedRepo: () =>
      selectedRepo.getSelectedRepo()?.config.repositoryRoot ?? null,
    onDidChange: graphReposChangedEmitter.event,
    rescan: () =>
      runExtensionEffect(
        syncReposWithWorkspaceFolders().pipe(Effect.zipRight(poll())),
        "Failed to rescan repositories for JJ Graph",
      ),
  };
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.openGraph", () => {
      JJGraphView.createOrShow(
        context.extensionUri,
        graphDataSource,
        graphRepoSource,
        graphPanelState,
        graphAvatarManager,
        graphLogger,
      );
    }),
  );

  // --- Workspace folder change listener ---
  await registerScoped(() =>
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      logger.info("Workspace folders changed");
      dispatchExtensionEffect(
        syncReposWithWorkspaceFolders().pipe(
          Effect.zipRight(poll()),
          Effect.zipRight(checkReposFunction?.() ?? Effect.void),
        ),
        "Failed to sync workspace folders",
      );
      graphReposChangedEmitter.fire();
    }),
  );

  await registerScoped(() =>
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("git")) {
        logger.info("Git configuration changed");
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const affectedFolders = workspaceFolders
          .filter((folder) => e.affectsConfiguration("git", folder.uri))
          .map((folder) => folder.uri.fsPath);
        if (affectedFolders.length > 0) {
          dispatchExtensionEffect(
            checkReposFunction?.(affectedFolders) ?? Effect.void,
            "Failed to update colocated repository warnings",
          );
        }
      }
    }),
  );

  if (repos.length > 0) {
    extensionViews = await initializeExtensionViews({
      extensionUri: context.extensionUri,
      repos: () => repos,
      selectedRepoController: selectedRepo,
      findRepoByUri,
      registerScoped,
      runInExtensionScope,
      dispatchExtensionEffect,
      runRepoCommand,
      refreshDisplayedState: repoLifecycle.refreshDisplayedState,
      runRepoEffect,
      retryImmutable,
      setGraphNodesSelectedContext: (count) =>
        extensionRuntime.runPromise(
          setContext("jjGraphView.nodesSelected", count).pipe(Effect.asVoid),
        ),
    });
  }

  await registerGlobalCommands(
    registerScoped,
    createGlobalCommandHandlers({
      repos: () => repos,
      repoLocator,
      selectedRepoController: selectedRepo,
      getGraphWebview: () => extensionViews?.graphWebview,
      getOperationLogManager: () => extensionViews?.operationLogManager,
      getWorkspacesManager: () => extensionViews?.workspacesManager,
      getReviewManager: () => reviewManager,
      getLastOpenedFileUri: () =>
        extensionViews?.getLastOpenedFileUri() ?? undefined,
      markGitFetchStarted: () => {
        extensionViews?.markGitFetchStarted();
      },
      refreshGitFetchStatus: () =>
        extensionViews?.refreshGitFetchStatus() ?? Effect.void,
      syncReposWithWorkspaceFolders,
      poll,
      getCheckColocatedReposEffect: () => checkReposFunction?.(),
      runExtensionEffect,
      dispatchExtensionEffect,
      runRepoCommand,
      runRepoEffect,
      retryImmutable,
      withSourceControlProgress,
    }),
  );

  await registerInitCommands(
    registerScoped,
    createInitCommandHandlers({
      repos: () => repos,
      repoLocator,
      selectedRepoController: selectedRepo,
      getGraphWebview: () => extensionViews?.graphWebview,
      getOperationLogManager: () => extensionViews?.operationLogManager,
      getWorkspacesManager: () => extensionViews?.workspacesManager,
      getReviewManager: () => reviewManager,
      getLastOpenedFileUri: () =>
        extensionViews?.getLastOpenedFileUri() ?? undefined,
      markGitFetchStarted: () => {
        extensionViews?.markGitFetchStarted();
      },
      refreshGitFetchStatus: () =>
        extensionViews?.refreshGitFetchStatus() ?? Effect.void,
      syncReposWithWorkspaceFolders,
      poll,
      getCheckColocatedReposEffect: () => checkReposFunction?.(),
      runExtensionEffect,
      dispatchExtensionEffect,
      runRepoCommand,
      runRepoEffect,
      retryImmutable,
      withSourceControlProgress,
    }),
  );

  // Background polling is handled by each repo's event loop fiber
  // (repoEventLoop in eventLoop.ts). No separate setTimeout loop needed.

  // --- Build test-compatible API ---
  // The test API must match { workspaceSCM, uri, repository }
  const workspaceSCM = buildWorkspaceSCMCompatLayer(
    () => repos,
    fileSystemProvider,
    repoLocator,
  );

  return {
    workspaceSCM,
    uri: await import("./uri"),
    graphWebview: await import("./graphWebview"),
    workspacesTreeView: await import("./workspacesTreeView"),
    repository: {
      parseRenamePaths,
      resolveRepoPath,
      isJjInternalPath,
      fakeEditorPath: extensionResourcesConfig.fakeEditorPath,
      ImmutableError: class ImmutableError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "ImmutableError";
        }
      },
    },
  };
}

export function deactivate() {}
