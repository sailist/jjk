import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffSide, encodeDiffDocUri } from "./diffDocUri";
import { ErrorInfo, GitFileStatus, GitRepoSet, RepoDropdownOrder } from "./types";

export class Disposable implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private disposed: boolean = false;

  /**
   * Disposes the resources used by the subclass.
   */
  public dispose() {
    this.disposed = true;
    this.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch (_) {
        void _;
      }
    });
    this.disposables = [];
  }

  /**
   * Register a single disposable.
   */
  protected registerDisposable(disposable: vscode.Disposable) {
    this.disposables.push(disposable);
  }

  /**
   * Register multiple disposables.
   */
  protected registerDisposables(...disposables: vscode.Disposable[]) {
    this.disposables.push(...disposables);
  }

  /**
   * Is the Disposable disposed.
   * @returns `TRUE` => Disposable has been disposed, `FALSE` => Disposable hasn't been disposed.
   */
  protected isDisposed() {
    return this.disposed;
  }
}

export function toDisposable(fn: () => void): vscode.Disposable {
  return {
    dispose: fn,
  };
}

/**
 * A function used by a subscriber to process an event emitted from an EventEmitter.
 */
type EventListener<T> = (event: T) => void;

/**
 * A function used to subscribe to an EventEmitter.
 */
export type Event<T> = (listener: EventListener<T>) => vscode.Disposable;

/**
 * Represents an EventEmitter, which is used to automate the delivery of events to subscribers. This applies the observer pattern.
 */
export class EventEmitter<T> implements vscode.Disposable {
  private readonly event: Event<T>;
  private listeners: EventListener<T>[] = [];

  /**
   * Creates an EventEmitter.
   */
  constructor() {
    this.event = (listener: EventListener<T>) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const removeListener = this.listeners.indexOf(listener);
          if (removeListener > -1) {
            this.listeners.splice(removeListener, 1);
          }
        },
      };
    };
  }

  /**
   * Disposes the resources used by the EventEmitter.
   */
  public dispose() {
    this.listeners = [];
  }

  /**
   * Emit an event to all subscribers of the EventEmitter.
   * @param event The event to emit.
   */
  public emit(event: T) {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (_) {
        void _;
      }
    });
  }

  /**
   * Does the EventEmitter have any registered listeners.
   * @returns TRUE => There are one or more registered subscribers, FALSE => There are no registered subscribers
   */
  public hasSubscribers() {
    return this.listeners.length > 0;
  }

  /**
   * Get the Event of this EventEmitter, which can be used to subscribe to the emitted events.
   * @returns The Event.
   */
  get subscribe() {
    return this.event;
  }
}

export const UNABLE_TO_FIND_JJ_MSG =
  'Unable to find a Jujutsu (jj) executable. Either: Set the Visual Studio Code Setting "jjk.jjPath" to the path and filename of an existing jj executable, or install jj and restart Visual Studio Code.';

export const NOT_SUPPORTED_MSG = "Not supported in JJ Graph";

/**
 * Get the standardised path from a string.
 */
export function getPathFromStr(str: string) {
  return path.normalize(str);
}

/**
 * Check whether a file exists at the specified path.
 * @param path The path of the file.
 * @returns TRUE => File exists, FALSE => File doesn't exist.
 */
export function doesFileExist(path: string) {
  return new Promise<boolean>((resolve) => {
    fs.access(path, fs.constants.F_OK, (err) => resolve(!err));
  });
}

/**
 * Abbreviate a commit hash to the first 8 characters.
 * @param commitHash The full commit hash.
 * @returns The abbreviated commit hash.
 */
export function abbrevCommit(commitHash: string) {
  return commitHash.substring(0, 8);
}

/**
 * Randomly generate a nonce.
 * @returns The nonce.
 */
export function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Get a short name for a repository.
 * @param path The path of the repository.
 * @returns The short name.
 */
export function getRepoName(path: string) {
  const firstSep = path.indexOf("/");
  if (firstSep === path.length - 1 || firstSep === -1) {
    return path; // Path has no slashes, or a single trailing slash ==> use the path
  } else {
    const p = path.endsWith("/") ? path.substring(0, path.length - 1) : path; // Remove trailing slash if it exists
    return p.substring(p.lastIndexOf("/") + 1);
  }
}

/**
 * Get a sorted list of repository paths from a given GitRepoSet.
 * @param repos The set of repositories.
 * @param order The order to sort the repositories.
 * @returns An array of ordered repository paths.
 */
export function getSortedRepositoryPaths(
  repos: GitRepoSet,
  order: RepoDropdownOrder,
): ReadonlyArray<string> {
  const repoPaths = Object.keys(repos);
  if (order === RepoDropdownOrder.WorkspaceFullPath) {
    return repoPaths.sort((a, b) =>
      repos[a].workspaceFolderIndex === repos[b].workspaceFolderIndex
        ? a.localeCompare(b)
        : repos[a].workspaceFolderIndex === null
          ? 1
          : repos[b].workspaceFolderIndex === null
            ? -1
            : repos[a].workspaceFolderIndex - repos[b].workspaceFolderIndex,
    );
  } else if (order === RepoDropdownOrder.FullPath) {
    return repoPaths.sort((a, b) => a.localeCompare(b));
  } else {
    return repoPaths
      .map((path) => ({ name: repos[path].name || getRepoName(path), path: path }))
      .sort((a, b) =>
        a.name !== b.name
          ? a.name.localeCompare(b.name)
          : a.path.localeCompare(b.path),
      )
      .map((x) => x.path);
  }
}

/* Visual Studio Code Command Wrappers */

/**
 * Copy the path of a file in a repository to the clipboard.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @param absolute TRUE => Absolute path, FALSE => Relative path.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyFilePathToClipboard(
  repo: string,
  filePath: string,
  absolute: boolean,
) {
  return copyToClipboard(absolute ? path.join(repo, filePath) : filePath);
}

/**
 * Copy a string to the clipboard.
 * @param text The string.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyToClipboard(text: string): Thenable<ErrorInfo> {
  return vscode.env.clipboard.writeText(text).then(
    () => null,
    () => "Visual Studio Code was unable to write to the Clipboard.",
  );
}

/**
 * Open the Visual Studio Code Settings Editor to the JJ Graph Extension Settings.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExtensionSettings(): Thenable<ErrorInfo> {
  return vscode.commands
    .executeCommand("workbench.action.openSettings", "jjk")
    .then(
      () => null,
      () => "Visual Studio Code was unable to open the JJ Graph Extension Settings.",
    );
}

/**
 * Open an External URL using the default application.
 * @param url The URL for Visual Studio Code to open.
 * @param type The type of URL being opened (defaults to "External URL").
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExternalUrl(
  url: string,
  type: string = "External URL",
): Thenable<ErrorInfo> {
  const getErrorMessage = () =>
    "Visual Studio Code was unable to open the " + type + ": " + url;
  try {
    return vscode.env.openExternal(vscode.Uri.parse(url)).then(
      (success) => (success ? null : getErrorMessage()),
      getErrorMessage,
    );
  } catch (_) {
    return Promise.resolve(getErrorMessage());
  }
}

/**
 * Open a file within a repository in Visual Studio Code.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function openFile(repo: string, filePath: string) {
  const absoluteFilePath = path.join(repo, filePath);
  const fileExists = await doesFileExist(absoluteFilePath);

  if (fileExists) {
    return vscode.commands
      .executeCommand("vscode.open", vscode.Uri.file(absoluteFilePath), {
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      })
      .then(
        () => null,
        () => "Visual Studio Code was unable to open " + filePath + ".",
      );
  } else {
    return (
      "The file " + filePath + " doesn't currently exist in this repository."
    );
  }
}

/**
 * Open the Visual Studio Code Diff View for a specific jj file change.
 * @param repo The repository the file is contained in.
 * @param fromHash The revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @param oldFilePath The relative path of the left-side file within the repository.
 * @param newFilePath The relative path of the right-side file within the repository.
 * @param type The Git file status of the change.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewDiff(
  repo: string,
  fromHash: string,
  toHash: string,
  oldFilePath: string,
  newFilePath: string,
  type: GitFileStatus,
) {
  if (type !== GitFileStatus.Untracked) {
    const abbrevFromHash = abbrevCommit(fromHash),
      abbrevToHash = abbrevCommit(toHash),
      pathComponents = newFilePath.split("/");
    const desc =
      fromHash === toHash
        ? type === GitFileStatus.Added
          ? "Added in " + abbrevToHash
          : type === GitFileStatus.Deleted
            ? "Deleted in " + abbrevToHash
            : abbrevFromHash + "- ↔ " + abbrevToHash
        : type === GitFileStatus.Added
          ? "Added between " + abbrevFromHash + " & " + abbrevToHash
          : type === GitFileStatus.Deleted
            ? "Deleted between " + abbrevFromHash + " & " + abbrevToHash
            : abbrevFromHash + " ↔ " + abbrevToHash;
    const title =
      pathComponents[pathComponents.length - 1] + " (" + desc + ")";

    return vscode.commands
      .executeCommand(
        "vscode.diff",
        encodeDiffDocUri(
          repo,
          oldFilePath,
          fromHash === toHash ? resolveParentRev(fromHash) : fromHash,
          type,
          DiffSide.Old,
        ),
        encodeDiffDocUri(repo, newFilePath, toHash, type, DiffSide.New),
        title,
        {
          preview: true,
          viewColumn: vscode.ViewColumn.Active,
        },
      )
      .then(
        () => null,
        () =>
          "Visual Studio Code was unable to load the diff editor for " +
          newFilePath +
          ".",
      );
  } else {
    return openFile(repo, newFilePath);
  }
}

/**
 * Open the Visual Studio Code Diff View to display the changes of a file between a revision and the working tree.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the left-side of the Diff View.
 * @param filePath The relative path of the file within the repository.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function viewDiffWithWorkingFile(
  repo: string,
  hash: string,
  filePath: string,
) {
  const fileExists = await doesFileExist(path.join(repo, filePath));
  const type = fileExists ? GitFileStatus.Modified : GitFileStatus.Deleted;

  const abbrevHash = abbrevCommit(hash);
  const pathComponents = filePath.split("/");
  const title =
    pathComponents[pathComponents.length - 1] +
    " (" +
    abbrevHash +
    " ↔ Present)";

  return vscode.commands
    .executeCommand(
      "vscode.diff",
      encodeDiffDocUri(repo, filePath, hash, type, DiffSide.Old),
      type === GitFileStatus.Deleted
        ? encodeDiffDocUri(repo, filePath, hash, type, DiffSide.New)
        : vscode.Uri.file(path.join(repo, filePath)),
      title,
      {
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      },
    )
    .then(
      () => null,
      () =>
        "Visual Studio Code was unable to load the diff editor for " +
        filePath +
        ".",
    );
}

/**
 * Open a Visual Studio Code Editor (readonly) for a file at a specific jj revision.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the file.
 * @param filePath The relative path of the file within the repository.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewFileAtRevision(
  repo: string,
  hash: string,
  filePath: string,
) {
  const pathComponents = filePath.split("/");
  const title =
    abbrevCommit(hash) + ": " + pathComponents[pathComponents.length - 1];

  return vscode.commands
    .executeCommand(
      "vscode.open",
      encodeDiffDocUri(
        repo,
        filePath,
        hash,
        GitFileStatus.Modified,
        DiffSide.New,
      ).with({ path: title }),
      {
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      },
    )
    .then(
      () => null,
      () =>
        "Visual Studio Code was unable to open " +
        filePath +
        " at commit " +
        abbrevCommit(hash) +
        ".",
    );
}

/**
 * Open the Visual Studio Code Source Control View.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewScm(): Thenable<ErrorInfo> {
  return vscode.commands.executeCommand("workbench.view.scm").then(
    () => null,
    () => "Visual Studio Code was unable to open the Source Control View.",
  );
}

/**
 * Resolve the revision selecting the parent of a change, for use in diff URI's.
 * @param hash The change hash (change id, or change_id "+" commit_id prefix for divergent changes).
 * @returns The jj revset expression selecting the parent of the change.
 */
export function resolveParentRev(hash: string) {
  const plusIndex = hash.indexOf("+");
  return (plusIndex > -1 ? hash.substring(plusIndex + 1) : hash) + "-";
}

/* Visual Studio Code API Wrappers */

/**
 * Show a Visual Studio Code Error Message Dialog with the specified message.
 * @param message The message to show.
 */
export function showErrorMessage(message: string) {
  return vscode.window.showErrorMessage(message).then(
    () => {},
    () => {},
  );
}

/* Promise Methods */

/**
 * Resolve the output of a spawned child process.
 * @param cmd The Child Process.
 * @returns Promise that resolves to [{code, error}, stdout, stderr]
 */
export function resolveSpawnOutput(cmd: cp.ChildProcess) {
  return Promise.all([
    new Promise<{ code: number; error: Error | null }>((resolve) => {
      // status promise
      let resolved = false;
      cmd.on("error", (error) => {
        if (resolved) {
          return;
        }
        resolve({ code: -1, error: error });
        resolved = true;
      });
      cmd.on("exit", (code) => {
        if (resolved) {
          return;
        }
        resolve({ code: code ?? -1, error: null });
        resolved = true;
      });
    }),
    new Promise<Buffer>((resolve) => {
      // stdout promise
      const buffers: Buffer[] = [];
      cmd.stdout?.on("data", (b: Buffer) => {
        buffers.push(b);
      });
      cmd.stdout?.on("close", () => resolve(Buffer.concat(buffers)));
    }),
    new Promise<string>((resolve) => {
      // stderr promise
      let stderr = "";
      cmd.stderr?.on("data", (d: string) => {
        stderr += d;
      });
      cmd.stderr?.on("close", () => resolve(stderr));
    }),
  ]);
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
  if (cspSource.startsWith("http://") || cspSource.startsWith("https://")) {
    const pathIndex = cspSource.indexOf("/", 8),
      queryIndex = cspSource.indexOf("?", 8),
      fragmentIndex = cspSource.indexOf("#", 8);
    let endOfAuthorityIndex = pathIndex;
    if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) {
      endOfAuthorityIndex = queryIndex;
    }
    if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) {
      endOfAuthorityIndex = fragmentIndex;
    }
    return endOfAuthorityIndex > -1
      ? cspSource.substring(0, endOfAuthorityIndex)
      : cspSource;
  } else {
    return cspSource;
  }
}
