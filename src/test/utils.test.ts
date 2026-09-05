import * as assert from "assert";
import * as path from "path";
import { getExtensionAPI } from "./extensionApi";

suite("isJjInternalPath", () => {
  const root = path.join(path.sep, "repo");
  let isJjInternalPath: (root: string, fsPath: string) => boolean;

  suiteSetup(async () => {
    ({ isJjInternalPath } = (await getExtensionAPI()).repository);
  });

  test("returns false for regular files under the root", () => {
    assert.strictEqual(
      isJjInternalPath(root, path.join(root, "src", "a.ts")),
      false,
    );
  });

  test("returns false for the root itself", () => {
    assert.strictEqual(isJjInternalPath(root, root), false);
  });

  test("returns false for paths outside the root", () => {
    assert.strictEqual(
      isJjInternalPath(root, path.join(path.sep, "other", ".jj", "x")),
      false,
    );
  });

  test("returns false for names merely containing .jj as a substring", () => {
    assert.strictEqual(
      isJjInternalPath(root, path.join(root, ".jjx", "a.ts")),
      false,
    );
    assert.strictEqual(
      isJjInternalPath(root, path.join(root, "a.jj", "b.ts")),
      false,
    );
  });

  test("returns true for the .jj directory itself", () => {
    assert.strictEqual(isJjInternalPath(root, path.join(root, ".jj")), true);
  });

  test("returns true for files inside .jj", () => {
    assert.strictEqual(
      isJjInternalPath(
        root,
        path.join(root, ".jj", "repo", "op_store", "operations", "abc"),
      ),
      true,
    );
  });

  test("returns true for nested .jj directories", () => {
    assert.strictEqual(
      isJjInternalPath(
        root,
        path.join(root, "sub", ".jj", "working_copy", "checkout"),
      ),
      true,
    );
  });
});
