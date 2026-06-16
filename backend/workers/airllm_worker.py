import multiprocessing
import time
import os
import uuid

# In a production desktop app, we use a simple dict manager or a local DB for task status.
# For simplicity, we'll write statuses to a local JSON or memory dictionary.
# We will use multiprocessing.Manager() dict in main.py to share state.

def _run_airllm_task(task_id: str, prompt: str, model_repo: str, result_dict: dict):
    """
    Executes the AirLLM 70B+ model layer-by-layer off the SSD.
    """
    try:
        from airllm import AutoModel
        
        result_dict[task_id] = {"status": "processing", "progress": 0, "result": None}
        
        # In a real environment, you'd allow the user to select the HF repo.
        # Defaulting to a massive model like llama-3-70b-instruct or similar.
        repo_id = model_repo or "garage-bAInd/Platypus2-70B-instruct"
        
        print(f"[AirLLM Worker] Loading {repo_id} for task {task_id}...")
        model = AutoModel.from_pretrained(repo_id)
        
        result_dict[task_id] = {"status": "processing", "progress": 50, "result": None}
        print(f"[AirLLM Worker] Generating deep analysis...")
        
        # The prompt is formatted for the massive model.
        input_text = [
            f"You are a master corporate analyst. Write a comprehensive deep-dive report.\n\nUser Request: {prompt}"
        ]
        
        input_tokens = model.tokenizer(input_text,
            return_tensors="pt", 
            return_attention_mask=False, 
            truncation=True, 
            max_length=512, 
            padding=False)
            
        generation_output = model.generate(
            input_tokens['input_ids'].cuda() if model.device.type == 'cuda' else input_tokens['input_ids'], 
            max_new_tokens=1000,
            use_cache=True,
            return_dict_in_generate=True)
            
        output = model.tokenizer.decode(generation_output.sequences[0])
        
        result_dict[task_id] = {"status": "completed", "progress": 100, "result": output}
        print(f"[AirLLM Worker] Task {task_id} completed successfully.")
        
    except Exception as e:
        print(f"[AirLLM Worker] Error during task {task_id}: {e}")
        result_dict[task_id] = {"status": "error", "progress": 0, "result": str(e)}

def airllm_worker_loop(task_queue: multiprocessing.Queue, result_dict: dict):
    """
    The background worker loop. Blocks until a task arrives.
    """
    print("🚀 [AirLLM Worker] Process started. Listening for deep analysis tasks...")
    while True:
        task = task_queue.get()
        if task is None:
            # Poison pill to shut down
            break
            
        task_id = task.get("task_id")
        prompt = task.get("prompt")
        model_repo = task.get("model_repo", "")
        
        _run_airllm_task(task_id, prompt, model_repo, result_dict)
