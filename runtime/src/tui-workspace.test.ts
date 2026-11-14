import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localGitBranch } from "./tui-workspace.js";

test("display-only git observation handles repositories, worktrees, nested paths and detached HEAD without commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-git-view-"));
  try {
    await mkdir(join(root, ".git")); await mkdir(join(root, "nested"));
    const head = join(root, ".git/HEAD");
    await writeFile(head, "ref: refs/heads/feature/cyberdeck\n");
    assert.equal(await localGitBranch(join(root, "nested")), "feature/cyberdeck");
    await writeFile(head, "a".repeat(40)); assert.equal(await localGitBranch(root), "detached aaaaaaaa");
    await writeFile(head, "ref: refs/heads/injected\x1b]52;c;secret\x07"); assert.equal(await localGitBranch(root), undefined);
    await writeFile(head, "x".repeat(5000)); assert.equal(await localGitBranch(root), undefined);
    await rm(head); await symlink("/etc/hosts", head); assert.equal(await localGitBranch(root), undefined);
    await rm(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "metadata")); await writeFile(join(root, "metadata/HEAD"), "ref: refs/heads/worktree\n");
    await writeFile(join(root, ".git"), "gitdir: metadata\n"); assert.equal(await localGitBranch(root), "worktree");
  } finally { await rm(root, { recursive: true, force: true }); }
});
