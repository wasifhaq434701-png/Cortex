import os

# Force HuggingFace into offline mode BEFORE importing sentence_transformers so the
# already-cached MiniLM model loads instantly with zero network HEAD checks. Without
# this, every boot blocks for tens of seconds (and spews resolve errors when offline)
# trying to reach huggingface.co. setdefault lets a power user re-enable a one-time
# download with HF_HUB_OFFLINE=0. The PyInstaller bundle ships the model, so offline
# is correct for the zero-terminal install goal.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np
from sentence_transformers import SentenceTransformer
import chromadb
from chromadb.config import Settings
import warnings

# Suppress verbose ChromaDB logging
warnings.filterwarnings("ignore", category=UserWarning)

# Initialize local embedding transformer model (loads from the local HF cache).
try:
    model = SentenceTransformer('all-MiniLM-L6-v2')
except Exception as e:
    model = None
    print(f"⚠️  [Embeddings] MiniLM model not available from local cache ({e}). "
          f"Run once with HF_HUB_OFFLINE=0 (online) to download it.")

# Setup ChromaDB Persistent Client
STORAGE_DIR = os.environ.get("MINDPALACE_STORAGE_DIR", os.path.join(os.path.dirname(__file__), "storage"))
os.makedirs(STORAGE_DIR, exist_ok=True)
CHROMA_PATH = os.path.join(STORAGE_DIR, "chroma_db")

# Use Settings to configure ChromaDB for persistent local storage
chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)

def get_collection_for_project(project_id: str):
    """Retrieves or creates a ChromaDB collection for a specific project."""
    if not project_id:
        project_id = "default_project"
    
    # ChromaDB collection names must be alphanumeric and contain no spaces
    safe_name = "".join(c if c.isalnum() else "_" for c in project_id)
    
    if len(safe_name) > 50:
        import hashlib
        safe_name = hashlib.md5(project_id.encode('utf-8')).hexdigest()
        
    safe_name = safe_name.strip('_')
    
    if not safe_name:
        safe_name = "default"
        
    return chroma_client.get_or_create_collection(name=f"project_{safe_name}")

def purge_orphaned_nodes(project_id: str, orphaned_files: list):
    """Deletes vectors from ChromaDB that belong to deleted/orphaned files."""
    if not orphaned_files:
        return
        
    collection = get_collection_for_project(project_id)
    
    for file_path in orphaned_files:
        try:
            collection.delete(where={"source_file": file_path})
        except Exception as e:
            print(f"Failed to purge {file_path} from ChromaDB: {e}")

def generate_embeddings(parsed_chunks: list, append: bool = False, project_id: str = "") -> list:
    """Generates semantic vectors for text chunks and provisions the ChromaDB search cache."""
    if not parsed_chunks:
        return parsed_chunks
        
    collection = get_collection_for_project(project_id)
    
    if not append:
        # Instead of clearing all memory, we clear the specific project collection.
        # But wait! If we do incremental scanning, we NEVER want to delete the whole collection
        # unless it's a completely fresh start. 
        # But 'append=False' implies a completely fresh start from the UI.
        # So we delete the collection and recreate it.
        try:
            safe_name = "".join(c if c.isalnum() else "_" for c in project_id) or "default"
            chroma_client.delete_collection(name=f"project_{safe_name}")
            collection = get_collection_for_project(project_id)
        except Exception:
            pass
    
    # Batch-encode all chunks at once
    if model is None:
        return parsed_chunks
    texts = [chunk["content"] for chunk in parsed_chunks]
    all_embeddings = model.encode(texts, show_progress_bar=True, batch_size=64)
    
    ids = []
    embeddings = []
    documents = []
    metadatas = []
    
    for chunk, embedding_vec in zip(parsed_chunks, all_embeddings):
        # Convert chunk data for ChromaDB upsert
        chunk_id = chunk["id"]
        
        # Safe metadata construction
        meta = {
            "source_file": chunk.get("source_file", ""),
            "cluster_id": chunk.get("cluster_id", 0)
        }
        
        # Ensure all meta values are strings, ints, or floats
        meta = {k: v for k, v in meta.items() if isinstance(v, (str, int, float))}
        
        ids.append(chunk_id)
        embeddings.append(embedding_vec.tolist())
        documents.append(chunk["content"])
        metadatas.append(meta)
        
        # Strip or convert the raw vector to list format for safe JSON delivery
        chunk["embedding"] = embedding_vec.tolist()
        
    # Upsert in batches to avoid Chroma limits
    batch_size = 5000
    for i in range(0, len(ids), batch_size):
        try:
            collection.upsert(
                ids=ids[i:i + batch_size],
                embeddings=embeddings[i:i + batch_size],
                documents=documents[i:i + batch_size],
                metadatas=metadatas[i:i + batch_size]
            )
        except Exception as e:
            print(f"Error upserting batch into ChromaDB: {e}")
        
    return parsed_chunks

def semantic_search(query: str, hyde_doc: str = "", top_k: int = 10, project_id: str = "") -> list:
    """Executes search against the partitioned ChromaDB vector space."""
    if not query:
        return []
        
    if model is None:
        return []
    collection = get_collection_for_project(project_id)

    # Advanced RAG: Use the Hypothetical Document if provided
    search_text = hyde_doc if hyde_doc else query
    query_vec = model.encode([search_text])
    
    try:
        results = collection.query(
            query_embeddings=query_vec.tolist(),
            n_results=top_k,
            include=["documents", "distances", "metadatas"]
        )
        
        out = []
        if results and "ids" in results and results["ids"] and len(results["ids"][0]) > 0:
            for idx in range(len(results["ids"][0])):
                node_id = results["ids"][0][idx]
                distance = results["distances"][0][idx] if "distances" in results else 0.0
                content = results["documents"][0][idx] if "documents" in results else ""
                
                # Chroma uses L2 distance or Cosine distance natively.
                # Smaller distance = better match.
                out.append({"id": node_id, "score": float(distance), "content": content})
                
        return out
    except Exception as e:
        print(f"Error encountered during mathematical vector search execution: {e}")
        return []