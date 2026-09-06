import * as vscode from "vscode";
import { JJDataSource } from "./dataSource";
import { decodeDiffDocUri, DIFF_DOC_SCHEME } from "./diffDocUri";
import { Disposable, showErrorMessage, toDisposable } from "./utils";

/**
 * Manages providing a specific revision of a repository file for use in the Visual Studio Code Diff View.
 */
export class DiffDocProvider extends Disposable implements vscode.TextDocumentContentProvider {
  public static scheme = DIFF_DOC_SCHEME;
  private readonly dataSource: JJDataSource;
  private readonly docs = new Map<string, DiffDocument>();
  private readonly onDidChangeEventEmitter = new vscode.EventEmitter<vscode.Uri>();

  /**
   * Creates the JJ Graph Diff Document Provider.
   * @param dataSource The JJ Graph DataSource instance.
   */
  constructor(dataSource: JJDataSource) {
    super();
    this.dataSource = dataSource;

    this.registerDisposables(
      vscode.workspace.onDidCloseTextDocument((doc) => this.docs.delete(doc.uri.toString())),
      this.onDidChangeEventEmitter,
      toDisposable(() => this.docs.clear()),
    );
  }

  /**
   * An event to signal a resource has changed.
   */
  get onDidChange() {
    return this.onDidChangeEventEmitter.event;
  }

  /**
   * Provides the content of a text document at a specific jj revision.
   * @param uri The `jj-graph://file.ext?encoded-data` URI.
   * @returns The content of the text document.
   */
  public provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const document = this.docs.get(uri.toString());
    if (document) {
      return document.value;
    }

    const request = decodeDiffDocUri(uri);
    if (!request.exists) {
      // Return empty file (used for one side of added / deleted file diff)
      return "";
    }

    return this.dataSource.getCommitFile(request.repo, request.commit, request.filePath).then(
      (contents) => {
        const document = new DiffDocument(contents);
        this.docs.set(uri.toString(), document);
        return document.value;
      },
      (errorMessage) => {
        showErrorMessage("Unable to retrieve file: " + errorMessage);
        return "";
      },
    );
  }
}

/**
 * Represents the content of a Diff Document.
 */
class DiffDocument {
  private readonly body: string;

  /**
   * Creates a Diff Document with the specified content.
   * @param body The content of the document.
   */
  constructor(body: string) {
    this.body = body;
  }

  /**
   * Get the content of the Diff Document.
   */
  get value() {
    return this.body;
  }
}
