import { z } from "zod";
import type { McpTool } from "./index.js";
import { createDoc, appendToDoc, listDocs } from "../gdocs.js";

const FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "";

export const gdocsTools: McpTool<any>[] = [
  {
    name: "sync_to_gdoc",
    description:
      "Sync a conversation to Google Docs (auto-syncs to NotebookLM). Creates a new doc or appends to an existing one.",
    schema: {
      title: z.string().describe("Title for the Google Doc"),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        )
        .describe("Conversation messages in order"),
      doc_id: z
        .string()
        .optional()
        .describe("Existing Google Doc ID to append to. If omitted, creates a new doc."),
      source_client: z
        .string()
        .optional()
        .describe("Source CLI (e.g. 'claude-cli', 'gemini-cli')"),
    },
    execute: async (_client, { title, messages, doc_id, source_client }) => {
      if (!FOLDER_ID) {
        throw new Error("GDRIVE_FOLDER_ID env var is required");
      }

      const header = [
        `# ${title}`,
        `Date: ${new Date().toISOString()}`,
        source_client ? `Source: ${source_client}` : null,
        `Messages: ${messages.length}`,
        "",
        "---",
        "",
      ]
        .filter(Boolean)
        .join("\n");

      const body = messages
        .map((m: { role: string; content: string }, i: number) => {
          const speaker = m.role === "user" ? "User" : "Assistant";
          return `### ${speaker} (${i + 1})\n\n${m.content}`;
        })
        .join("\n\n---\n\n");

      const content = header + body;

      if (doc_id) {
        await appendToDoc(doc_id, content);
        return {
          message: "Conversation appended to existing doc",
          doc_id,
          message_count: messages.length,
        };
      }

      const result = await createDoc(title, content, FOLDER_ID);
      return {
        message: "Conversation saved to new Google Doc",
        doc_id: result.docId,
        doc_url: result.url,
        message_count: messages.length,
      };
    },
  },
  {
    name: "gdoc_list",
    description: "List conversation docs in the shared Google Drive folder",
    execute: async () => {
      if (!FOLDER_ID) {
        throw new Error("GDRIVE_FOLDER_ID env var is required");
      }
      const docs = await listDocs(FOLDER_ID);
      return { docs, count: docs.length };
    },
  },
];
