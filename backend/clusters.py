import numpy as np
from sklearn.manifold import TSNE
from sklearn.cluster import KMeans

def calculate_coordinates_and_clusters(nodes: list) -> list:
    """Calculates 3D spatial coordinates and assigns color clusters to nodes."""
    if not nodes:
        return []

    # Extract the vector arrays
    embeddings = np.array([node["embedding"] for node in nodes])
    n_samples = len(embeddings)

    # ---------------------------------------------------------
    # EDGE CASE FALLBACK: Etremely small files (1 to 3 chunks)
    # TSNE requires at least 4 samples to calculate 3D space.
    # If the file is too small, we manually assign them coordinates.
    # ---------------------------------------------------------
    if n_samples < 4:
        for i, node in enumerate(nodes):
            # Just scatter them slightly apart in a line
            node[""] = float(i * 10)
            node["y"] = float(i * 10)
            node["z"] = float(i * 10)
            node["cluster_id"] = 0  # Put them all in the same color group
        return nodes

    # ---------------------------------------------------------
    # DYNAMIC MATH CALCULATION
    # ---------------------------------------------------------
    # TSNE perplexity MUST be strictly less than the number of samples.
    # Default is 30, but we scale it down if n_samples is small.
    safe_perplexity = min(30, n_samples - 1)

    try:
        # Calculate 3D coordinates
        tsne = TSNE(n_components=3, perplexity=safe_perplexity, random_state=42)
        coords = tsne.fit_transform(embeddings)

        # Dynamic Clustering: You cannot have more color groups than you have chunks.
        safe_clusters = min(6, n_samples)
        kmeans = KMeans(n_clusters=safe_clusters, random_state=42)
        cluster_ids = kmeans.fit_predict(embeddings)

        # Map the math back to our dictionary
        for i, node in enumerate(nodes):
            node["x"] = float(coords[i][0])
            node["y"] = float(coords[i][1])
            node["z"] = float(coords[i][2])
            node["cluster_id"] = int(cluster_ids[i])

    except Exception as e:
        print(f"Mathematical clustering failed: {e}")
        # Ultimate fallback so the server never crashes
        for i, node in enumerate(nodes):
            node[""], node["y"], node["z"] = 0.0, 0.0, 0.0
            node["cluster_id"] = 0

    return nodes