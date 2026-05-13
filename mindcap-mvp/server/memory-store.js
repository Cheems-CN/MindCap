const { MemoryVectorStore } = require("@langchain/classic/vectorstores/memory");
const db = require("./db");

/**
 * Load all saved vectors from SQLite into a MemoryVectorStore.
 * Returns the populated store, ready for VectorStoreRetrieverMemory.
 */
async function createPopulatedVectorStore(userId, embeddings) {
  const vectorStore = new MemoryVectorStore(embeddings);

  const rows = db.loadMemoryVectors(userId);
  if (rows.length === 0) return vectorStore;

  // Build documents and vectors arrays for batch add
  const vectors = [];
  const documents = [];
  for (const row of rows) {
    vectors.push(row.embedding);
    documents.push({
      pageContent: row.inputText,
      metadata: { outputText: row.outputText, userId }
    });
  }

  // Use addVectors to populate without re-computing embeddings
  await vectorStore.addVectors(vectors, documents);
  return vectorStore;
}

/**
 * Persist a saveContext call to SQLite.
 * Called after vectorStore internally stores the new entry.
 */
async function persistContext(userId, inputText, outputText, embeddings) {
  if (!userId || !inputText || !embeddings) return;

  const embedding = await embeddings.embedQuery(inputText);
  db.saveMemoryVector(userId, inputText, outputText, embedding);
}

module.exports = { createPopulatedVectorStore, persistContext };
