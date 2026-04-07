import { z } from "zod";
import { McpTool, pendingConfirmation } from "./index.js";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

export const sourceTools: McpTool<any>[] = [
  {
    name: "source_describe",
    description: "Get metadata for a specific source in a notebook",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      source_id: z.string().describe("The source ID"),
    },
    execute: async (client, { notebook_id, source_id }) => {
      const source = await client.getSource(source_id, notebook_id);
      return { source };
    },
  },
  {
    name: "source_get_content",
    description: "Get the underlying text content of a source (used by grounding tool)",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      source_id: z.string().describe("The document ID to retrieve"),
    },
    execute: async (client, { notebook_id, source_id }) => {
      const source = await client.getSource(source_id, notebook_id);
      return { text: source.content };
    },
  },
  {
    name: "notebook_add_url",
    description: "Add a website URL source to a notebook",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      url: z.string().describe("The URL to add"),
    },
    execute: async (client, { notebook_id, url }) => {
      await client.addUrlSource(notebook_id, url);
      return { message: "URL source added" };
    },
  },
  {
    name: "notebook_add_text",
    description: "Add a text document source to a notebook",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      content: z.string().optional().describe("The text content to add"),
      file_path: z.string().optional().describe("Path to local file to read content from"),
      title: z.string().describe("Title for the new source"),
    },
    execute: async (client, { notebook_id, content, file_path, title }) => {
      let documentContent = content;
      if (!documentContent && file_path) {
        const resolved = resolve(file_path);
        documentContent = await fs.readFile(resolved, "utf8");
      }
      if (!documentContent) {
        throw new Error("Must provide either content or file_path");
      }
      await client.addTextSource(notebook_id, documentContent, title);
      return { message: "Text source added" };
    },
  },
  {
    name: "notebook_add_drive",
    description: "Add a Google Drive file source to a notebook",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      file_id: z.string().describe("Google Drive file ID"),
      title: z.string().describe("Document title"),
      doc_type: z.string().describe("MIME type (e.g. application/vnd.google-apps.document)"),
    },
    execute: async (client, { notebook_id, file_id, title, doc_type }) => {
      await client.addDriveSource(notebook_id, file_id, title, doc_type);
      return { message: "Drive source added" };
    },
  },
  {
    name: "source_list_drive",
    description: "List sources in a notebook with Drive freshness status",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
    },
    execute: async (client, { notebook_id }) => {
      const notebook = await client.getNotebook(notebook_id);
      const results = [];
      for (const src of notebook.sources) {
        const fresh = await client.checkFreshness(src.id, notebook_id);
        results.push({ ...src, is_fresh: fresh });
      }
      return { sources: results };
    },
  },
  {
    name: "source_sync_drive",
    description: "Sync all Drive sources in a notebook to pull latest changes",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      source_ids: z.array(z.string()).describe("Source IDs to sync"),
      confirm: z.boolean().describe("Must be true to confirm sync"),
    },
    execute: async (client, { notebook_id, source_ids, confirm }) => {
      if (!confirm) return pendingConfirmation("Set confirm=true to sync these Drive sources.");
      await client.syncDrive(source_ids, notebook_id);
      return { message: `Synced ${source_ids.length} sources` };
    },
  },
  {
    name: "sync_conversation",
    description:
      "Sync a conversation transcript to a NotebookLM notebook as a formatted text source",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      title: z.string().describe("Title for the conversation source"),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        )
        .describe("Conversation messages in order"),
      source_client: z
        .string()
        .optional()
        .describe("Source CLI (e.g. 'claude-cli', 'gemini-cli')"),
    },
    execute: async (
      client,
      { notebook_id, title, messages, source_client },
    ) => {
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
      await client.addTextSource(notebook_id, content, title);
      return { message: "Conversation synced", message_count: messages.length };
    },
  },
  {
    name: "source_delete",
    description: "Delete a source from a notebook (requires confirm=true)",
    schema: {
      notebook_id: z.string().describe("The notebook ID"),
      source_id: z.string().describe("The source ID"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    execute: async (client, { notebook_id, source_id, confirm }) => {
      if (!confirm) return pendingConfirmation("Set confirm=true to delete this source. This cannot be undone.");
      await client.deleteSource(source_id, notebook_id);
      return { message: "Source deleted" };
    },
  },
];
