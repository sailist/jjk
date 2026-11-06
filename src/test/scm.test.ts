import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { WorkspaceSourceControlManager } from "../repoHandle";

suite("SCM Integration Tests", () => {
  let workspaceSCM: WorkspaceSourceControlManager;
  let WorkspaceTreeItem: typeof import("../workspacesTreeView").WorkspaceTreeItem;
  let repoRoot: string;
  let originalOperation: string;

  suiteSetup(async function () {
    this.timeout(30_000);

    const api = await getExtensionAPI();
    workspaceSCM = api.workspaceSCM;
    WorkspaceTreeItem = api.workspacesTreeView.WorkspaceTreeItem;

    // Wait for initial repo detection if needed
    if (workspaceSCM.repoSCMs.length === 0) {
      await workspaceSCM.refresh();
      for (let i = 0; i < 10 && workspaceSCM.repoSCMs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await workspaceSCM.refresh();
      }
    }

    assert.ok(workspaceSCM.repoSCMs.length > 0, "No jj repositories detected");
    repoRoot = workspaceSCM.repoSCMs[0].repositoryRoot;

    // Ensure state is fully populated
    await vscode.commands.executeCommand("jj.refresh");

    const output = await execJJPromise(
      'operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async function () {
    this.timeout(10_000);
    await execJJPromise(`operation restore ${originalOperation}`);
    // Let the extension pick up the restored state
    await vscode.commands.executeCommand("jj.refresh");
  });

  test("edit file → save → verify resource groups → jj.new → verify state", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];

    // Working copy should start clean (no file changes)
    const initialResourceStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      initialResourceStates.length,
      0,
      `Expected clean working copy, but found ${initialResourceStates.length} files: ${initialResourceStates.map((s) => s.resourceUri.fsPath).join(", ")}`,
    );

    // Create a new file in the repo
    const testFileName = "test-integration-file.txt";
    const testFilePath = path.join(repoRoot, testFileName);
    await fs.writeFile(testFilePath, "hello from integration test\n");

    // Open and save the file through VS Code (triggers file watchers)
    const doc = await vscode.workspace.openTextDocument(testFilePath);
    await vscode.window.showTextDocument(doc);
    await doc.save();

    // Refresh — this snapshots the working copy and updates SCM state.
    // jj.refresh awaits the full poll() cycle, so state is current when it resolves.
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the file shows up in the working copy resource group
    const workingCopyStates = repoSCM.workingCopyResourceGroup.resourceStates;
    const addedFile = workingCopyStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      addedFile,
      `Expected ${testFileName} in working copy resource group, but found: ${workingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );

    // Record the current working copy change ID
    const workingCopyChangeIdBefore = repoSCM.status?.workingCopy.changeId;
    assert.ok(workingCopyChangeIdBefore, "Expected a working copy change ID");

    // Execute jj.new via the source control.
    // The command handler calls repository.new() but does not await a refresh.
    // The file watcher will eventually trigger checkForUpdates, but we force
    // a refresh afterwards to get deterministic timing.
    await vscode.commands.executeCommand("jj.new", repoSCM.sourceControl);
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the working copy is now empty (new change has no modifications)
    const postNewWorkingCopyStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      postNewWorkingCopyStates.length,
      0,
      `Expected empty working copy after jj.new, but found ${postNewWorkingCopyStates.length} files: ${postNewWorkingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ")}`,
    );

    // Verify the working copy change ID has changed
    const workingCopyChangeIdAfter = repoSCM.status?.workingCopy.changeId;
    assert.ok(
      workingCopyChangeIdAfter,
      "Expected a working copy change ID after jj.new",
    );
    assert.notStrictEqual(
      workingCopyChangeIdAfter,
      workingCopyChangeIdBefore,
      "Working copy change ID should have changed after jj.new",
    );

    // Verify the file now shows up in a parent resource group
    assert.ok(
      repoSCM.parentResourceGroups.length > 0,
      "Expected at least one parent resource group after jj.new",
    );
    const parentStates = repoSCM.parentResourceGroups.flatMap(
      (g) => g.resourceStates,
    );
    const fileInParent = parentStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      fileInParent,
      `Expected ${testFileName} in parent resource group, but found: ${parentStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );
  });

  test("toggle Changes between individual commits and the whole branch diff", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];
    const testFileName = "branch-diff-integration-file.txt";
    const testFilePath = path.join(repoRoot, testFileName);
    const showCommits = async () => {
      if (!repoSCM.branchDiffResourceGroup.hideWhenEmpty) {
        await vscode.commands.executeCommand("jj.toggleChangesView");
      }
    };

    await showCommits();
    try {
      await fs.writeFile(testFilePath, "first commit\n");
      await vscode.commands.executeCommand("jj.refresh");
      await vscode.commands.executeCommand("jj.new", repoSCM.sourceControl);
      await vscode.commands.executeCommand("jj.refresh");
      await fs.appendFile(testFilePath, "working copy\n");
      await vscode.commands.executeCommand("jj.refresh");

      await vscode.commands.executeCommand("jj.toggleChangesView");

      assert.strictEqual(repoSCM.parentResourceGroups.length, 0);
      assert.strictEqual(repoSCM.workingCopyResourceGroup.hideWhenEmpty, true);
      assert.strictEqual(
        repoSCM.workingCopyResourceGroup.resourceStates.length,
        0,
      );
      assert.strictEqual(repoSCM.branchDiffResourceGroup.hideWhenEmpty, false);
      const branchStates =
        repoSCM.branchDiffResourceGroup.resourceStates.filter((state) =>
          state.resourceUri.fsPath.endsWith(testFileName),
        );
      assert.strictEqual(
        branchStates.length,
        1,
        "Expected one aggregated branch entry for a file changed in multiple commits",
      );
      assert.strictEqual(
        repoSCM.sourceControl.count,
        repoSCM.branchDiffResourceGroup.resourceStates.length,
      );

      await vscode.commands.executeCommand("jj.toggleChangesView");

      assert.strictEqual(repoSCM.branchDiffResourceGroup.hideWhenEmpty, true);
      assert.strictEqual(repoSCM.workingCopyResourceGroup.hideWhenEmpty, false);
      assert.ok(
        repoSCM.parentResourceGroups.some((group) =>
          group.resourceStates.some((state) =>
            state.resourceUri.fsPath.endsWith(testFileName),
          ),
        ),
        "Expected the individual commit groups to be restored",
      );
      assert.ok(
        repoSCM.workingCopyResourceGroup.resourceStates.some((state) =>
          state.resourceUri.fsPath.endsWith(testFileName),
        ),
        "Expected the working copy group to be restored",
      );
    } finally {
      await showCommits();
    }
  });

  test("active workspace changes view refreshes on file save without manual refresh", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];

    const wsName = "jjktestws";
    const wsRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "jjk-test-ws-")),
    );

    const showWorkspace = (name: string, root: string, active: boolean) =>
      vscode.commands.executeCommand(
        "jj.workspaceShow",
        new WorkspaceTreeItem(
          {
            name,
            root,
            targetChangeId: "",
            isEmpty: false,
            isConflict: false,
            isDivergent: false,
          },
          repoRoot,
          false,
          active,
          false,
        ),
      );

    try {
      await execJJPromise(`workspace add --name ${wsName} "${wsRoot}"`, {
        cwd: repoRoot,
        timeout: 10_000,
      });

      await showWorkspace(wsName, wsRoot, true);

      const testFileName = "ws-integration-file.txt";
      const testFilePath = path.join(wsRoot, testFileName);
      await fs.writeFile(testFilePath, "hello from workspace test\n");
      const doc = await vscode.workspace.openTextDocument(testFilePath);
      await vscode.window.showTextDocument(doc);
      await doc.save();

      // The working copy watcher must pick up the save on its own; no
      // jj.refresh here, so a missing trigger fails the test.
      let addedFile;
      for (let i = 0; i < 150 && !addedFile; i++) {
        await new Promise((r) => setTimeout(r, 100));
        addedFile = repoSCM.workingCopyResourceGroup.resourceStates.find(
          (state) => state.resourceUri.fsPath.endsWith(testFileName),
        );
      }
      assert.ok(
        addedFile,
        `Expected ${testFileName} in active workspace's working copy resource group without manual refresh, but found: ${repoSCM.workingCopyResourceGroup.resourceStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
      );
    } finally {
      await showWorkspace("default", repoRoot, false);
      await execJJPromise(`workspace forget ${wsName}`, { cwd: repoRoot });
      await fs.rm(wsRoot, { recursive: true, force: true });
      await vscode.commands.executeCommand("jj.refresh");
    }
  });
});
