import * as vscode from "vscode";

export const EMPTY_REVIEW_DOC_SCHEME = "jj-review-empty";

export class EmptyReviewDocProvider
  implements vscode.TextDocumentContentProvider
{
  provideTextDocumentContent(): string {
    return "";
  }
}

export const emptyReviewDocUri = (fileUri: vscode.Uri): vscode.Uri =>
  fileUri.with({ scheme: EMPTY_REVIEW_DOC_SCHEME, query: "" });
