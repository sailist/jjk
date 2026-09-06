import * as path from "path";
import * as vscode from "vscode";
import { GitFileStatus } from "./types";

export const enum DiffSide {
  Old,
  New,
}

export const DIFF_DOC_SCHEME = "jj-graph";

/**
 * Represents the data passed through `jj-graph://file.ext?encoded-data` URI's by the DiffDocProvider.
 */
export type DiffDocUriData = {
  filePath: string;
  commit: string;
  repo: string;
  exists: boolean;
};

/**
 * Produce the URI of a file to be used in the Visual Studio Diff View.
 * @param repo The repository the file is within.
 * @param filePath The path of the file.
 * @param commit The commit hash specifying the revision of the file.
 * @param type The Git file status of the change.
 * @param diffSide The side of the Diff View that this URI will be displayed on.
 * @returns A URI of the form `jj-graph://file.ext?encoded-data`
 */
export function encodeDiffDocUri(
  repo: string,
  filePath: string,
  commit: string,
  type: GitFileStatus,
  diffSide: DiffSide,
): vscode.Uri {
  const fileDoesNotExist =
    (diffSide === DiffSide.Old && type === GitFileStatus.Added) ||
    (diffSide === DiffSide.New && type === GitFileStatus.Deleted);
  const data: DiffDocUriData = {
    filePath: path.normalize(filePath),
    commit: commit,
    repo: repo,
    exists: !fileDoesNotExist,
  };

  let extension: string;
  if (fileDoesNotExist) {
    extension = "";
  } else {
    const extIndex = data.filePath.indexOf(".", data.filePath.lastIndexOf("/") + 1);
    extension = extIndex > -1 ? data.filePath.substring(extIndex) : "";
  }

  return vscode.Uri.file("file" + extension).with({
    scheme: DIFF_DOC_SCHEME,
    query: Buffer.from(JSON.stringify(data)).toString("base64"),
  });
}

/**
 * Decode the data from a `jj-graph://file.ext?encoded-data` URI.
 * @param uri The URI to decode data from.
 * @returns The decoded DiffDocUriData.
 */
export function decodeDiffDocUri(uri: vscode.Uri): DiffDocUriData {
  return JSON.parse(Buffer.from(uri.query, "base64").toString()) as DiffDocUriData;
}
