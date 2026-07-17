import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ResearchReader,
  sendReaderNotification,
  type NotificationProvider,
} from "../src/index.js";

test("local folder, Obsidian, LaTeX, Zotero, and conference adapters create Passports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-adapters-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    assert.deepEqual(reader.adapters(), [
      "conference",
      "folder",
      "latex",
      "obsidian",
      "pubmed",
      "zotero",
    ]);
    assert.equal(reader.adapterContract().version, 1);

    const folder = path.join(root, "folder-input");
    await mkdir(folder);
    await writeFile(
      path.join(folder, "paper.md"),
      "# Folder Paper\n\nLocal evidence.",
      "utf8",
    );
    const folderResult = await reader.runAdapter("folder", folder);
    assert.equal(folderResult.createdPapers, 1);
    assert.equal(folderResult.imported, 1);

    const vault = path.join(root, "vault");
    await mkdir(vault);
    await writeFile(
      path.join(vault, "note.md"),
      "---\ntitle: Obsidian Paper\ntags: [robotics, planning]\n---\n\nEvidence.",
      "utf8",
    );
    assert.equal((await reader.runAdapter("obsidian", vault)).createdPapers, 1);

    const latex = path.join(root, "paper.tex");
    await writeFile(
      latex,
      "\\title{LaTeX Paper}\\author{Ada Reader}\\section{Method}World model.",
      "utf8",
    );
    assert.equal((await reader.runAdapter("latex", latex)).imported, 1);

    const zotero = path.join(root, "zotero.json");
    await writeFile(
      zotero,
      `${JSON.stringify([
        {
          id: "zotero-1",
          title: "Zotero Paper",
          DOI: "10.1000/zotero",
          URL: "https://doi.org/10.1000/zotero",
          abstract: "Zotero abstract evidence.",
          author: [{ given: "Ada", family: "Reader" }],
          issued: { "date-parts": [[2026]] },
        },
        {
          id: "zotero-2",
          title: "Zotero Paper Two",
          URL: "https://example.org/zotero-2",
          abstract: "Second abstract.",
        },
      ])}\n`,
      "utf8",
    );
    const zoteroResult = await reader.runAdapter("zotero", zotero, {
      limit: 1,
    });
    assert.equal(zoteroResult.imported, 1);
    assert.match(zoteroResult.warnings.join(" "), /Stopped after 1 Zotero/);
    const zoteroPaper = (await reader.listPapers()).find(
      (item) => item.metadata.doi === "10.1000/zotero",
    );
    assert.equal(zoteroPaper?.acquisition.status, "metadata-only");
    await assert.rejects(
      () =>
        reader.reviewPaper(zoteroPaper!.id, {
          level: "standard",
          llmProvider: {
            name: "unused",
            async complete() {
              throw new Error("must not call");
            },
          },
        }),
      /requires acquired full text/,
    );

    const conference = path.join(root, "conference.json");
    await writeFile(
      conference,
      `${JSON.stringify([
        {
          id: "conference-1",
          title: "Conference Paper",
          url: "https://example.org/conference-paper",
          venue: "ReaderConf",
          year: 2026,
          abstract: "Accepted paper abstract.",
        },
      ])}\n`,
      "utf8",
    );
    assert.equal(
      (await reader.runAdapter("conference", conference)).createdPapers,
      1,
    );
    assert.equal((await reader.listPapers()).length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PubMed adapter requires approval and supports deterministic injected fetch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-pubmed-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await assert.rejects(
      () => reader.runAdapter("pubmed", "robot planning"),
      /explicit network approval/,
    );
    const result = await reader.runAdapter("pubmed", "robot planning", {
      approveNetwork: true,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) {
          return new Response(
            JSON.stringify({ esearchresult: { idlist: ["123"] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              uids: ["123"],
              "123": {
                uid: "123",
                title: "PubMed Robot Planning",
                pubdate: "2026 Jul",
                fulljournalname: "Journal of Reader Tests",
                elocationid: "doi: 10.1000/pubmed",
                authors: [{ name: "Reader A" }],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(result.createdPapers, 1);
    assert.equal(result.imported, 0);
    assert.equal(
      (await reader.listPapers())[0]?.metadata.doi,
      "10.1000/pubmed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notification contract keeps local output safe and gates external providers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-notification-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const filePath = path.join(root, "notifications.jsonl");
    await reader.notifyFile(filePath, {
      title: "Reader report",
      body: "One priority paper.",
      paperIds: ["paper-1"],
    });
    assert.match(await readFile(filePath, "utf8"), /Reader report/);
    const external: NotificationProvider = {
      name: "external-fixture",
      external: true,
      async send() {
        throw new Error("must not send");
      },
    };
    await assert.rejects(
      () =>
        sendReaderNotification(external, {
          title: "Blocked",
          body: "No approval",
          createdAt: new Date().toISOString(),
        }),
      /explicit approval/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
