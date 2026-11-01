import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

test("Pi conversation identity survives a SQLite close and reopen without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-pi-"));
  const path = join(directory, "conversation.sqlite");
  const options = { models: createModels(), registry: createRegistry() };
  try {
    const first = await Harness.open(await openNodeSqliteStorage(path), options, BACKGROUND_CONTEXT);
    let id: ConversationId;
    try {
      id = (await first.root(BACKGROUND_CONTEXT)).id;
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }
    const second = await Harness.open(await openNodeSqliteStorage(path), options, BACKGROUND_CONTEXT);
    try {
      assert.equal((await second.root(BACKGROUND_CONTEXT)).id, id);
    } finally {
      await second.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
