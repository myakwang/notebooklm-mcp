import { google } from "googleapis";

let authClient: ReturnType<typeof google.auth.GoogleAuth.prototype.getClient> | null = null;

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is required (JSON string of service account key)");
  }

  const credentials = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

function getDocs() {
  return google.docs({ version: "v1", auth: getAuth() });
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

/**
 * Create a new Google Doc in the specified folder and write content to it.
 */
export async function createDoc(
  title: string,
  content: string,
  folderId: string,
): Promise<{ docId: string; url: string }> {
  const drive = getDrive();

  // Create empty doc in folder
  const file = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      parents: [folderId],
    },
    fields: "id,webViewLink",
  });

  const docId = file.data.id!;
  const url = file.data.webViewLink!;

  // Write content
  const docs = getDocs();
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content,
          },
        },
      ],
    },
  });

  return { docId, url };
}

/**
 * Append content to an existing Google Doc.
 */
export async function appendToDoc(
  docId: string,
  content: string,
): Promise<void> {
  const docs = getDocs();

  // Get current document length
  const doc = await docs.documents.get({ documentId: docId });
  const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: endIndex - 1 },
            text: "\n\n" + content,
          },
        },
      ],
    },
  });
}

/**
 * List docs in the shared folder.
 */
export async function listDocs(
  folderId: string,
): Promise<{ id: string; name: string; modifiedTime: string }[]> {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 50,
  });

  return (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
  }));
}
