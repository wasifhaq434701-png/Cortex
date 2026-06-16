import { env, AutoTokenizer } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

// Skip local model checks since we just want to use HF models for tokenization
env.allowLocalModels = false;

let activeTokenizer = null;
let currentTokenizerRepo = 'Xenova/llama3-tokenizer-fast'; // Default fallback

self.onmessage = async (e) => {
    const { type, data, id } = e.data;

    if (type === 'LOAD_MODEL') {
        const { modelName } = data;
        self.postMessage({ type: 'MODEL_STATUS', status: 'loading', model: modelName });
        
        try {
            // If it's a local model, we make a dummy API call to load it into VRAM asynchronously
            if (modelName.startsWith('local:')) {
                const actualName = modelName.split(':')[1];
                try {
                    await fetch('http://localhost:11434/api/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: actualName, prompt: "", keep_alive: "5m" })
                    });
                } catch (ollamaErr) {
                    console.warn("Ollama pre-load failed (is daemon running?):", ollamaErr);
                }
            }
            
            // Map the active model to an appropriate tokenizer repository
            let hfModelForTokenizer = 'Xenova/llama3-tokenizer-fast';
            if (modelName.toLowerCase().includes('qwen')) {
                hfModelForTokenizer = 'Xenova/Qwen1.5-0.5B-Chat'; // closest fast tokenizer available in transformers.js
            }
            
            if (currentTokenizerRepo !== hfModelForTokenizer || !activeTokenizer) {
                currentTokenizerRepo = hfModelForTokenizer;
                try {
                    activeTokenizer = await AutoTokenizer.from_pretrained(hfModelForTokenizer);
                } catch(err) {
                    // Fallback
                    activeTokenizer = await AutoTokenizer.from_pretrained('Xenova/llama3-tokenizer-fast');
                }
            }

            self.postMessage({ type: 'MODEL_STATUS', status: 'ready', model: modelName });
        } catch (err) {
            self.postMessage({ type: 'MODEL_STATUS', status: 'error', error: err.message, model: modelName });
        }
    } 
    else if (type === 'TOKENIZE') {
        if (!activeTokenizer) {
            self.postMessage({ type: 'TOKENIZE_RESULT', id, error: 'Tokenizer not loaded' });
            return;
        }
        
        const { text, contextLimit } = data;
        // Count tokens
        const tokens = await activeTokenizer(text);
        const count = tokens.input_ids.size || tokens.input_ids.length;
        
        // Check if eceeds 80%
        const threshold = Math.floor(contextLimit * 0.8);
        const isOverload = count > threshold;
        
        self.postMessage({ 
            type: 'TOKENIZE_RESULT', 
            id, 
            count, 
            isOverload,
            threshold
        });
    }
};
