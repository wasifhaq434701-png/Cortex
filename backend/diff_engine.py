import difflib

def compute_diff_patches(original_text: str, modified_text: str):
    """
    Computes a sequence of structured patches using difflib.
    Returns a list of operations:
    {
        "tag": str, # "replace", "delete", "insert"
        "start_line": int, # 1-indexed
        "end_line": int,   # 1-indexed
        "replacement": str
    }
    """
    original_lines = original_text.splitlines(keepends=True)
    modified_lines = modified_text.splitlines(keepends=True)
    
    matcher = difflib.SequenceMatcher(None, original_lines, modified_lines)
    patches = []
    
    # We yield them in reverse order to apply them safely without messing up subsequent line numbers,
    # or the frontend should handle applying patches backwards.
    # Actually, difflib yields them in order. Frontend needs to apply in reverse or handle offsets.
    # Let's reverse them here so frontend can just apply them sequentially safely.
    for tag, i1, i2, j1, j2 in reversed(matcher.get_opcodes()):
        if tag == 'equal':
            continue
            
        replacement = "".join(modified_lines[j1:j2])
        
        patches.append({
            "tag": tag,
            "start_line": i1 + 1,
            "end_line": max(i1, i2), # Avoid end_line < start_line for pure inserts
            "replacement": replacement
        })
        
    return patches
